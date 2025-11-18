# server/server.py
# Python 3.10+
import asyncio, json, time, os, sys
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from mcc_bridge import MCCBridge, AIFrame
from mcc_bridge import BRIDGE_VERSION, HAVE_MCCULW, HAVE_ULDAQ
from pid_core import PIDManager
from filters import OnePoleLPFBank
from logger import SessionLogger
from app_models import AppConfig, PIDFile, ScriptFile, default_config
import logging, os
SERVER_VERSION = "0.7.2"


MCC_TICK_LOG = os.environ.get("MCC_TICK_LOG", "1") == "1"  # print 1 line per second
MCC_DUMP_FIRST = int(os.environ.get("MCC_DUMP_FIRST", "5")) # dump first N ticks fully

ROOT = Path(__file__).resolve().parent.parent
CFG_DIR = ROOT/"server/config"
WEB_DIR = ROOT/"web"
LOGS_DIR = ROOT/"server"/"logs"
LOGS_DIR.mkdir(parents=True, exist_ok=True)

# env toggles (all optional)
LOG_TICKS = os.environ.get("MCC_TICK_LOG", "0") == "0"          # per-second tick print
LOG_EVERY = max(1, int(os.environ.get("MCC_LOG_EVERY", "1")))   # write CSV every N ticks
BROADCAST_EVERY = max(1, int(os.environ.get("MCC_BROADCAST_EVERY", "2")))  # WS send every N ticks

logging.basicConfig(
    level=os.environ.get("MCC_LOGLEVEL", "INFO"),
    format="%(message)s"
)
log = logging.getLogger("mcc")


print(f"[MCC-Hub] Python {sys.version.split()[0]} on {sys.platform}")
print(f"[MCC-Hub] ROOT={ROOT}")
print(f"[MCC-Hub] CFG_DIR={CFG_DIR} exists={CFG_DIR.exists()}")
print(f"[MCC-Hub] WEB_DIR={WEB_DIR} exists={WEB_DIR.exists()}")
print(f"[MCC-Hub] LOGS_DIR={LOGS_DIR} exists={LOGS_DIR.exists()}")

# Ensure web dir so StaticFiles won't explode on first run
if not WEB_DIR.exists():
    WEB_DIR.mkdir(parents=True, exist_ok=True)
    (WEB_DIR/"index.html").write_text("""
<!doctype html><html><body>
<h1>MCC Hub: Web folder was missing</h1>
<p>This placeholder was created automatically. Copy the /web files here and refresh.</p>
</body></html>
""")

app = FastAPI()

@app.middleware("http")
async def _no_cache(request, call_next):
    resp = await call_next(request)
    # disable caching for our UI assets and APIs
    if request.url.path in ("/", "/index.html", "/app.js", "/styles.css") or request.url.path.startswith("/api/"):
        resp.headers["Cache-Control"] = "no-store, max-age=0"
        resp.headers["Pragma"] = "no-cache"
        resp.headers["Expires"] = "0"
    return resp

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], allow_credentials=True, allow_methods=["*"], allow_headers=["*"]
)

# NEW: serve config.json the old way so the existing Config editor works
app.mount("/config", StaticFiles(directory=CFG_DIR), name="config")
#app.mount("/web", StaticFiles(directory=WEB_DIR), name="web")


# ---- Layout save/load ----
LAYOUT_PATH = CFG_DIR / "layout.json"

# diag endpoint MUST be after `app = FastAPI()` (and after MCCBridge import)
@app.get("/api/diag")
def api_diag():
    # Safely pull board numbers if available
    cfg = getattr(mcc, "cfg", None)
    b1608 = getattr(getattr(cfg, "board1608", None), "boardNum", None)
    betc  = getattr(getattr(cfg, "boardetc",  None), "boardNum", None)

    return {
        "server": SERVER_VERSION,
        "bridge": BRIDGE_VERSION,
        "have_mcculw": bool(HAVE_MCCULW),
        "have_uldaq": bool(HAVE_ULDAQ),
        "board1608": b1608,
        "boardetc": betc,
    }

@app.get("/api/version")
def get_version():
    return {
        "server": SERVER_VERSION,
        "bridge": BRIDGE_VERSION,
    }

@app.get("/api/layout")
def get_layout():
    if LAYOUT_PATH.exists():
        import json
        return json.loads(LAYOUT_PATH.read_text(encoding="utf-8"))
    return {"version": "v1", "pages": []}

@app.put("/api/layout")
def put_layout(body: dict):
    import json
    LAYOUT_PATH.write_text(json.dumps(body, indent=2), encoding="utf-8")
    return {"ok": True}


# ---- Serve index and assets explicitly so /ws is not intercepted ----
from fastapi.responses import FileResponse, HTMLResponse

@app.get("/", response_class=HTMLResponse)
def _root():
    return (WEB_DIR / "index.html").read_text(encoding="utf-8")

@app.get("/index.html", response_class=HTMLResponse)
def _root_index():
    # Serve the same file for /index.html as for /
    return (WEB_DIR / "index.html").read_text(encoding="utf-8")

@app.get("/app.js")
def _app_js():
    return FileResponse(str(WEB_DIR / "app.js"))

@app.get("/styles.css")
def _styles_css():
    return FileResponse(str(WEB_DIR / "styles.css"))

@app.get("/favicon.ico")
def _favicon():
    ico = WEB_DIR / "favicon.ico"
    if ico.exists():
        return FileResponse(str(ico))
    # harmless fallback
    return FileResponse(str(WEB_DIR / "index.html"))

# ---------- Models ----------
class RateReq(BaseModel):
    hz: float

class DOReq(BaseModel):
    index: int
    state: bool
    active_high: bool = True

class BuzzReq(BaseModel):
    index: int
    hz: float
    active_high: bool = True

class AOReq(BaseModel):
    index: int
    volts: float

# ---------- Load config/PID/script ----------
CFG_PATH = CFG_DIR/"config.json"
PID_PATH = CFG_DIR/"pid.json"
SCRIPT_PATH = CFG_DIR/"script.json"

if not CFG_PATH.exists():
    CFG_DIR.mkdir(parents=True, exist_ok=True)
    CFG_PATH.write_text(json.dumps(default_config(), indent=2))
if not PID_PATH.exists():
    PID_PATH.write_text(json.dumps({"loops": []}, indent=2))
if not SCRIPT_PATH.exists():
    SCRIPT_PATH.write_text(json.dumps({"events": []}, indent=2))

# ---- Pydantic v2-friendly loader with legacy script.json migration ----
from typing import Type

def _load_json_model(path: Path, model_cls: Type[BaseModel]):
    try:
        txt = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        txt = "{}"
    # First try fast path (JSON text)
    try:
        return model_cls.model_validate_json(txt)
    except Exception:
        pass
    # Fallback: parse into Python, fix legacy shapes, then validate
    try:
        data = json.loads(txt) if txt.strip() else {}
    except Exception as e:
        print(f"[MCC-Hub] JSON load failed for {path.name}: {e}; using defaults")
        data = {}
    # Legacy script.json was a top-level list -> wrap into {"events": [...]} and rewrite
    if model_cls.__name__ == "ScriptFile" and isinstance(data, list):
        print("[MCC-Hub] Migrating legacy script.json (list) -> {events:[...]}")
        data = {"events": data}
        try:
            path.write_text(json.dumps(data, indent=2))
        except Exception:
            pass
    try:
        return model_cls.model_validate(data)
    except Exception as e:
        print(f"[MCC-Hub] Validation failed for {path.name}: {e}; using defaults")
        # Minimal safe defaults per model
        if model_cls.__name__ == "AppConfig":
            return AppConfig.model_validate(default_config())
        if model_cls.__name__ == "PIDFile":
            return PIDFile.model_validate({"loops": []})
        if model_cls.__name__ == "ScriptFile":
            return ScriptFile.model_validate({"events": []})
        return model_cls.model_validate({})

app_cfg = _load_json_model(CFG_PATH, AppConfig)
pid_file = _load_json_model(PID_PATH, PIDFile)
script_file = _load_json_model(SCRIPT_PATH, ScriptFile)
print("[MCC-Hub] Loaded config / pid / script")

mcc = MCCBridge()
bridge = mcc  # alias for older handlers that still say 'bridge'

pid_mgr = PIDManager()
pid_mgr.load(pid_file)

# Filters per AI ch (configured by config.json -> analogs[i].cutoffHz)
lpf = OnePoleLPFBank()

ws_clients: List[WebSocket] = []
session_logger: Optional[SessionLogger] = None
run_task: Optional[asyncio.Task] = None
acq_rate_hz: float = max(1.0, app_cfg.board1608.sampleRateHz)
_need_reconfig_filters = False

@app.on_event("startup")
def _on_startup():
    print("[MCC-Hub] FastAPI startup")

@app.on_event("shutdown")
def _on_shutdown():
    print("[MCC-Hub] FastAPI shutdown")

async def broadcast(msg: dict):
    txt = json.dumps(msg, separators=(",", ":"))  # pre-encode once
    living = []
    for ws in ws_clients:
        try:
            await ws.send_text(txt)
            living.append(ws)
        except Exception:
            # don't spam; just drop dead client
            pass
    ws_clients[:] = living

async def acq_loop():
    """
    Main acquisition loop.

    - Samples the hardware at acq_rate_hz (AI).
    - Samples thermocouples at a much lower fixed rate (TC_RATE_HZ).
    - Runs scaling, LPF, and PIDs on every AI sample.
    - Logs every LOG_EVERY samples.
    - Broadcasts to the browser at a lower fixed UI rate (~TARGET_UI_HZ),
      regardless of acq_rate_hz, to avoid overloading the websocket/JS.
    """
    global session_logger, _need_reconfig_filters

    # Target UI update rate (for charts/widgets)
    TARGET_UI_HZ = 25.0
    # Max TC read rate; TCs are slow, don't hammer them every AI sample
    TC_RATE_HZ = 10.0

    ticks = 0
    log_ctr = 0
    bcast_ctr = 0

    print(f"[MCC-Hub] Acquisition loop starting @ {acq_rate_hz} Hz")
    last = time.perf_counter()

    # Prepare filters from config
    lpf.configure(
        rate_hz=acq_rate_hz,
        cutoff_list=[a.cutoffHz for a in app_cfg.analogs],
    )

    # Start session logging folder
    session_dir = LOGS_DIR / datetime.now().strftime("%Y%m%d_%H%M%S")
    session_dir.mkdir(parents=True, exist_ok=True)
    session_logger = SessionLogger(session_dir)
    await broadcast({"type": "session", "dir": session_dir.name})
    print(f"[MCC-Hub] Logging to {session_dir}")

    # Start hardware
    try:
        mcc.open(app_cfg)
        print("[MCC-Hub] Hardware open() complete")
    except Exception as e:
        print(f"[MCC-Hub] Hardware open() failed: {e}")

    # TC throttling state
    last_tc_vals: List[float] = []
    last_tc_time = time.perf_counter()
    min_tc_interval = 1.0 / max(1.0, TC_RATE_HZ)

    try:
        while True:
            # Pacing from current acquisition rate (responds to /api/acq/rate)
            dt = 1.0 / max(1.0, acq_rate_hz)
            now = time.perf_counter()
            to_sleep = dt - (now - last)
            if to_sleep > 0:
                await asyncio.sleep(to_sleep)
            last = time.perf_counter()

            # Reconfigure LPF if rate changed
            if _need_reconfig_filters:
                lpf.configure(
                    rate_hz=acq_rate_hz,
                    cutoff_list=[a.cutoffHz for a in app_cfg.analogs],
                )
                _need_reconfig_filters = False
                print(f"[MCC-Hub] Reconfigured LPF for rate {acq_rate_hz} Hz")

            # --- Read AI every tick ---
            try:
                ai_raw = mcc.read_ai_all()
            except Exception as e:
                print(f"[MCC-Hub] AI read failed: {e}")
                ai_raw = [0.0] * 8

            # --- Read TCs at a much lower rate ---
            now_tc = time.perf_counter()
            if now_tc - last_tc_time >= min_tc_interval:
                try:
                    last_tc_vals = mcc.read_tc_all()
                except Exception as e:
                    print(f"[MCC-Hub] TC read failed: {e}")
                    # keep last_tc_vals as-is on failure
                last_tc_time = now_tc
            tc_vals = last_tc_vals

            # --- Scale + LPF AI values ---
            ai_scaled: List[float] = []
            for i, raw in enumerate(ai_raw):
                try:
                    m = app_cfg.analogs[i].slope
                    b = app_cfg.analogs[i].offset
                except Exception:
                    m, b = 1.0, 0.0
                y = m * raw + b
                y = lpf.apply(i, y)
                ai_scaled.append(y)

            # --- PIDs (may drive DO/AO) ---
            telemetry = pid_mgr.step(
                ai_vals=ai_scaled,
                tc_vals=tc_vals,
                bridge=mcc,
            )

            # Snapshot of outputs
            ao = mcc.get_ao_snapshot()
            do = mcc.get_do_snapshot()

            frame = {
                "type": "tick",
                "t": time.time(),
                "ai": ai_scaled,
                "ao": ao,
                "do": do,
                "tc": tc_vals,
                "pid": telemetry,
            }

            ticks += 1
            log_ctr += 1
            bcast_ctr += 1

            # --- Logging: at full acq rate (or LOG_EVERY) ---
            if log_ctr >= LOG_EVERY and session_logger is not None:
                session_logger.write(frame)
                log_ctr = 0

            # --- Websocket broadcast: auto-decimated to ~TARGET_UI_HZ ---
            # Base decimation from env (if you want it coarser)
            env_bcast_every = BROADCAST_EVERY  # usually 1
            # Automatic decimation for UI smoothness
            auto_bcast_every = max(
                1,
                int(round(acq_rate_hz / max(1.0, TARGET_UI_HZ))),
            )
            effective_bcast_every = max(env_bcast_every, auto_bcast_every)

            if bcast_ctr >= effective_bcast_every:
                await broadcast(frame)
                bcast_ctr = 0

            # Debug for first few ticks
            if ticks <= MCC_DUMP_FIRST:
                try:
                    ai_str = ["%.3f" % v for v in ai_scaled]
                    ao_str = ["%.3f" % v for v in ao]
                    tc_str = [
                        ("%.1f" % v) if v is not None else "nan"
                        for v in (tc_vals or [])
                    ]
                    print(
                        f"[DBG] tick#{ticks} ai={ai_str}  ao={ao_str}  do={do}  tc={tc_str}"
                    )
                except Exception:
                    # Don't let formatting kill the loop
                    pass

    finally:
        print("[MCC-Hub] Acquisition loop stopping")
        mcc.close()
        if session_logger:
            session_logger.close()
            session_logger = None




# ---------- REST: configuration ----------
class BuzzStart(BaseModel):
    index: int
    hz: float = 10.0
    active_high: bool = True


@app.get("/api/config")
def get_config():
    # read latest from disk so external edits are visible
    cfg = _load_json_model(CFG_PATH, AppConfig)
    return cfg.model_dump()

@app.put("/api/config")
def put_config(body: dict):
    global app_cfg, _need_reconfig_filters
    app_cfg = AppConfig.model_validate(body)
    CFG_PATH.write_text(json.dumps(app_cfg.model_dump(), indent=2))
    _need_reconfig_filters = True
    print("[MCC-Hub] Config updated")
    return {"ok": True}

@app.get("/api/pid")
def get_pid():
    return _load_json_model(PID_PATH, PIDFile).model_dump()

@app.put("/api/pid")
def put_pid(body: dict):
    global pid_file
    pid_file = PIDFile.model_validate(body)
    PID_PATH.write_text(json.dumps(pid_file.model_dump(), indent=2))
    pid_mgr.load(pid_file)
    print("[MCC-Hub] PID file updated")
    return {"ok": True}

@app.get("/api/script")
def get_script():
    return _load_json_model(SCRIPT_PATH, ScriptFile).model_dump()

@app.put("/api/script")
def put_script(body: dict):
    global script_file
    # accept legacy list payload as well and wrap
    if isinstance(body, list):
        body = {"events": body}
    script_file = ScriptFile.model_validate(body)
    SCRIPT_PATH.write_text(json.dumps(script_file.model_dump(), indent=2))
    print("[MCC-Hub] Script updated")
    return {"ok": True}

# ---------- REST: control ----------

@app.post("/api/acq/rate")
def set_rate(req: RateReq):
    global acq_rate_hz, _need_reconfig_filters
    acq_rate_hz = max(1.0, float(req.hz))
    _need_reconfig_filters = True

    # Reconfigure the E-1608 AI block scan to match the new acquisition rate.
    # This keeps the hardware sampling in sync with the logical acq_rate_hz,
    # while still using block-based reads under the hood for performance.
    try:
        mcc.configure_ai_scan(acq_rate_hz, app_cfg.board1608.blockSize)
    except Exception as e:
        print(f"[MCC-Hub] AI scan reconfig warn: {e}")

    print(f"[MCC-Hub] Rate set to {acq_rate_hz} Hz")
    return {"ok": True, "hz": acq_rate_hz}

@app.post("/api/do/set")
def set_do(req: DOReq):
    #print(f"[CMD] DO{req.index} <- {req.state} (active_high={req.active_high})")
    mcc.set_do(req.index, req.state, active_high=req.active_high)
    return {"ok": True}

class BuzzStop(BaseModel):
    index: int

@app.post("/api/do/buzz/start")
async def api_buzz_start(req: BuzzStart):
    await mcc.start_buzz(int(req.index), float(req.hz), bool(req.active_high))
    return {"ok": True}

@app.post("/api/do/buzz/stop")
async def api_buzz_stop(req: BuzzStop):
    await mcc.stop_buzz(int(req.index))
    return {"ok": True}

@app.post("/api/ao/set")
def set_ao(req: AOReq):
    #print(f"[CMD] AO{req.index} <- {req.volts} V")
    mcc.set_ao(req.index, req.volts)
    return {"ok": True}

# ---------- REST: logs ----------
@app.get("/api/logs")
def list_logs():
    return sorted([p.name for p in LOGS_DIR.glob("*") if p.is_dir()])

@app.get("/api/logs/{session}/csv")
def download_csv(session: str):
    path = LOGS_DIR/session/"session.csv"
    return FileResponse(str(path), filename=f"{session}.csv")

# @app.get("/api/diag")
# def diag():
#     from mcc_bridge import HAVE_MCCULW, HAVE_ULDAQ
#     return {
#         "mcculw": HAVE_MCCULW,
#         "uldaq": HAVE_ULDAQ,
#         "board1608": app_cfg.board1608.model_dump(),
#         "boardetc": app_cfg.boardetc.model_dump(),
#     }

# ---------- WebSocket ----------
@app.websocket("/ws")
async def ws(ws: WebSocket):
    await ws.accept()
    ws_clients.append(ws)
    print(f"[WS] client connected; total={len(ws_clients)}")

    # If this is the first client, start acquisition
    global run_task
    if run_task is None or run_task.done():
        print("[WS] starting acquisition task")
        run_task = asyncio.create_task(acq_loop())

    try:
        while True:
            _ = await ws.receive_text()  # keepalive or client cmds in future
    except WebSocketDisconnect:
        print("[WS] disconnect")
    finally:
        if ws in ws_clients:
            ws_clients.remove(ws)
        if not ws_clients and run_task:
            print("[WS] no clients; stopping acquisition task")
            run_task.cancel()
            try:
                await run_task
            except Exception as e:
                print(f"[WS] task exit: {e}")
            run_task = None

# app.mount("/", StaticFiles(directory=str(WEB_DIR), html=True), name="static")

if __name__ == "__main__":
    import uvicorn, os
    port = int(os.environ.get("PORT", "8000"))
    # Quieter defaults; allow overrides via env if needed
    uv_level = os.environ.get("UVICORN_LEVEL", "warning").lower()  # "info" or "warning"
    access = os.environ.get("UVICORN_ACCESS", "0") == "0"       # set to 1 to re-enable

    print(f"[MCC-Hub] Starting Uvicorn on http://127.0.0.1:{port}")
    uvicorn.run(app, host="0.0.0.0", port=port, log_level=uv_level, access_log=access)
