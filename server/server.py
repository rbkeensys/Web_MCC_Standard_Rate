# server/server.py
# Python 3.10+
import asyncio, json, time, os, sys, math
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
from app_models import AppConfig, PIDFile, ScriptFile, MotorFile, default_config
from motor_controller import MotorManager, list_serial_ports
from logic_elements import LEManager
from math_ops import MathOpManager, MathOpFile
from app_models import LEFile, LogicElementCfg
import logging, os
SERVER_VERSION = "0.9.10"  # Fixed NaN to None conversion for TC and math telemetry


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
        if model_cls.__name__ == "MotorFile":
            return MotorFile.model_validate({"motors": []})
        return model_cls.model_validate({})

app_cfg = _load_json_model(CFG_PATH, AppConfig)
pid_file = _load_json_model(PID_PATH, PIDFile)
script_file = _load_json_model(SCRIPT_PATH, ScriptFile)
MOTOR_PATH = CFG_DIR / "motor.json"
motor_file = _load_json_model(MOTOR_PATH, MotorFile)
print("[MCC-Hub] Loaded config / pid / script / motor")

mcc = MCCBridge()
bridge = mcc  # alias for older handlers that still say 'bridge'

pid_mgr = PIDManager()
pid_mgr.load(pid_file)

motor_mgr = MotorManager()

# Logic Elements
le_mgr = LEManager()
LE_PATH = CFG_DIR / "logic_elements.json"
MATH_PATH = CFG_DIR / "math_operators.json"

# Math Operators
math_mgr = MathOpManager()

def load_le():
    global le_mgr
    if LE_PATH.exists():
        try:
            data = json.loads(LE_PATH.read_text())
            le_mgr.load(data)
            log.info(f"[LE] Loaded {len(le_mgr.elements)} logic elements")
        except Exception as e:
            log.error(f"[LE] Failed to load: {e}")
            le_mgr = LEManager()
    else:
        log.info("[LE] No logic_elements.json found, creating default")
        LE_PATH.write_text(json.dumps({"elements": []}, indent=2))

load_le()

def load_math():
    global math_mgr
    if MATH_PATH.exists():
        try:
            data = json.loads(MATH_PATH.read_text())
            math_file = MathOpFile.model_validate(data)
            math_mgr.load(math_file)
            log.info(f"[MathOps] Loaded {len(math_mgr.operators)} math operators")
        except Exception as e:
            log.error(f"[MathOps] Failed to load: {e}")
            import traceback
            traceback.print_exc()
            math_mgr = MathOpManager()
    else:
        log.info("[MathOps] No math_operators.json found, creating default")
        MATH_PATH.write_text(json.dumps({"operators": []}, indent=2))

load_math()

# AO Enable Gate Tracking
# Track desired values separately from what's actually written to hardware
ao_desired_values = [0.0, 0.0]  # Desired voltage for each AO
ao_last_gate_state = [True, True]  # Track if gate was enabled last tick

# Initialize motors from config
for idx, motor_cfg in enumerate(motor_file.motors):
    if motor_cfg.include:
        motor_mgr.add_motor(idx, motor_cfg.model_dump())

# Filters per AI ch (configured by config.json -> analogs[i].cutoffHz)
lpf = OnePoleLPFBank()
# Filters per TC ch (configured by config.json -> thermocouples[i].cutoffHz)
lpf_tc = OnePoleLPFBank()

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
    motor_mgr.disconnect_all()
    print("[MCC-Hub] Motors disconnected")

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
    lpf_tc.configure(
        rate_hz=acq_rate_hz,
        cutoff_list=[tc.cutoffHz for tc in app_cfg.thermocouples],
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
        
        # Initialize analog outputs to startup values
        # Set multiple times because hardware may reset to default (often 1V for AO0)
        print("[MCC-Hub] Initializing AOs to startup values...")
        for attempt in range(3):  # Try 3 times
            for i, ao_cfg in enumerate(app_cfg.analogOutputs):
                if ao_cfg.include:
                    try:
                        mcc.set_ao(i, ao_cfg.startupV)
                        if attempt == 0:
                            print(f"[MCC-Hub]   AO{i} -> {ao_cfg.startupV}V (startup)")
                    except Exception as e:
                        if attempt == 0:
                            print(f"[MCC-Hub]   AO{i} FAILED: {e}")
            await asyncio.sleep(0.05)  # Small delay between attempts
        
        print("[MCC-Hub] AO initialization complete")
        
    except Exception as e:
        print(f"[MCC-Hub] Hardware open() failed: {e}")

    # TC throttling state
    last_tc_vals: List[float] = []
    last_tc_time = time.perf_counter()
    min_tc_interval = 1.0 / max(1.0, TC_RATE_HZ)
    
    # PID telemetry from previous cycle (for cascade control)
    last_pid_telemetry: List[Dict] = []

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
                lpf_tc.configure(
                    rate_hz=acq_rate_hz,
                    cutoff_list=[tc.cutoffHz for tc in app_cfg.thermocouples],
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
            
            # Apply offset and LPF to TC values
            tc_vals: List[float] = []
            for i, raw in enumerate(last_tc_vals):
                try:
                    offset = app_cfg.thermocouples[i].offset if i < len(app_cfg.thermocouples) else 0.0
                    val = raw + offset
                    val = lpf_tc.apply(i, val)
                    tc_vals.append(val)
                except Exception:
                    tc_vals.append(raw)

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

            # Get DO/AO snapshot BEFORE PID and LE evaluation
            # (needed for both LE inputs and PID gate checking)
            ao = mcc.get_ao_snapshot()
            do = mcc.get_do_snapshot()

            # --- Logic Elements ---
            # Evaluate BEFORE PIDs so PIDs can use LE outputs as enable gates
            le_outputs = le_mgr.evaluate_all({
                "ai": ai_scaled,
                "ao": ao,
                "do": do,
                "tc": tc_vals,
                "pid": []  # PIDs haven't run yet
            })
            le_tel = le_mgr.get_telemetry()

            # --- Math Operators ---
            # Evaluate AFTER LEs but BEFORE PIDs so PIDs can use math outputs
            math_tel = math_mgr.evaluate_all({
                "ai": ai_scaled,
                "ao": ao,
                "tc": tc_vals,
                "pid": [],  # PIDs haven't run yet
                "le": le_outputs
            })

            # --- PIDs (may drive DO/AO) ---
            # Pass DO/LE state so PIDs can check their enable gates
            # Pass previous cycle's PID telemetry for cascade control (pid source)
            # Pass math outputs so PIDs can use math as source
            telemetry = pid_mgr.step(
                ai_vals=ai_scaled,
                tc_vals=tc_vals,
                bridge=mcc,
                do_state=do,
                le_state=le_tel,
                pid_prev=last_pid_telemetry,
                math_outputs=[m.get("output", 0.0) for m in math_tel]
            )
            
            # Store for next cycle
            last_pid_telemetry = telemetry

            # --- Logic Elements (Re-evaluation) ---
            # Re-evaluate LEs after PIDs so LEs can use PID outputs as inputs
            le_outputs = le_mgr.evaluate_all({
                "ai": ai_scaled,
                "ao": ao,
                "do": do,
                "tc": tc_vals,
                "pid": telemetry
            })
            le_tel = le_mgr.get_telemetry()

            # --- AO Enable Gating ---
            # Check gates and apply/restore values as needed
            global ao_desired_values, ao_last_gate_state
            
            for i, ao_cfg in enumerate(app_cfg.analogOutputs):
                if not ao_cfg.include:
                    continue
                    
                if ao_cfg.enable_gate:
                    # Check the enable signal
                    enable_signal = False
                    
                    if ao_cfg.enable_kind == "do":
                        if ao_cfg.enable_index < len(do):
                            enable_signal = bool(do[ao_cfg.enable_index])
                    elif ao_cfg.enable_kind == "le":
                        if ao_cfg.enable_index < len(le_tel):
                            enable_signal = le_tel[ao_cfg.enable_index].get("output", False)
                    
                    # Check for state transitions
                    was_enabled = ao_last_gate_state[i] if i < len(ao_last_gate_state) else True
                    
                    if enable_signal and not was_enabled:
                        # Transition: disabled -> enabled
                        # Restore the desired value
                        try:
                            mcc.set_ao(i, ao_desired_values[i])
                        except Exception as e:
                            print(f"[AO] Failed to restore AO{i} to {ao_desired_values[i]}V: {e}")
                    elif not enable_signal and was_enabled:
                        # Transition: enabled -> disabled
                        # Force to 0V
                        try:
                            mcc.set_ao(i, 0.0)
                        except Exception as e:
                            print(f"[AO] Failed to gate AO{i} to 0V: {e}")
                    # If state hasn't changed, don't write (avoid unnecessary traffic)
                    
                    # Update last state
                    if i < len(ao_last_gate_state):
                        ao_last_gate_state[i] = enable_signal

            # --- Motor Controllers ---
            # Update each enabled motor based on its input source
            motor_status = []
            for idx, motor_cfg in enumerate(motor_file.motors):
                if not motor_cfg.enabled or not motor_cfg.include:
                    continue
                
                try:
                    # Get input value
                    input_val = 0.0
                    if motor_cfg.input_source == "ai" and motor_cfg.input_channel < len(ai_scaled):
                        input_val = ai_scaled[motor_cfg.input_channel]
                    elif motor_cfg.input_source == "ao" and motor_cfg.input_channel < len(ao):
                        input_val = ao[motor_cfg.input_channel]
                    elif motor_cfg.input_source == "tc" and motor_cfg.input_channel < len(tc_vals):
                        input_val = tc_vals[motor_cfg.input_channel]
                    elif motor_cfg.input_source == "pid" and motor_cfg.input_channel < len(telemetry):
                        # Get PID U (output) value
                        pid_info = telemetry[motor_cfg.input_channel]
                        # Use lowercase 'u' which is standard in telemetry
                        input_val = pid_info.get('u', 0.0)
                    
                    # Clamp input to input range (bounds checking)
                    input_val = max(motor_cfg.input_min, min(motor_cfg.input_max, input_val))
                    
                    # Calculate RPM: RPM = input * scale + offset
                    # Direct multiplication (no normalization)
                    # Example: input=-240, scale=1000, offset=0 -> RPM=-240000
                    rpm = input_val * motor_cfg.scale_factor + motor_cfg.offset
                    
                    # Update motor
                    success = motor_mgr.set_motor_rpm(idx, rpm, motor_cfg.cw_positive)
                    
                    motor_status.append({
                        "index": idx,
                        "input": input_val,
                        "rpm_cmd": rpm,
                        "success": success
                    })
                except Exception as e:
                    log.error(f"Motor {idx} update failed: {e}")
                    motor_status.append({
                        "index": idx,
                        "input": 0.0,
                        "rpm_cmd": 0.0,
                        "success": False,
                        "error": str(e)
                    })

            # Convert NaN to None for JSON serialization
            # (Python's json.dumps doesn't support NaN)
            import math
            tc_vals_json = [None if not math.isfinite(v) else v for v in tc_vals]
            
            # Also convert NaN in math telemetry
            math_tel_json = []
            for m in math_tel:
                m_clean = m.copy()
                if 'input_a' in m_clean and not math.isfinite(m_clean['input_a']):
                    m_clean['input_a'] = None
                if 'input_b' in m_clean and m_clean['input_b'] is not None and not math.isfinite(m_clean['input_b']):
                    m_clean['input_b'] = None
                if 'output' in m_clean and not math.isfinite(m_clean['output']):
                    m_clean['output'] = None
                math_tel_json.append(m_clean)

            frame = {
                "type": "tick",
                "t": time.time(),
                "ai": ai_scaled,
                "ao": ao,
                "do": do,
                "tc": tc_vals_json,
                "pid": telemetry,
                "motors": motor_status,
                "le": le_tel,
                "math": math_tel_json,
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

# ---------- REST: motors ----------

@app.get("/api/motors")
def get_motors():
    return _load_json_model(MOTOR_PATH, MotorFile).model_dump()

@app.put("/api/motors")
def put_motors(body: dict):
    global motor_file, motor_mgr
    motor_file = MotorFile.model_validate(body)
    MOTOR_PATH.write_text(json.dumps(motor_file.model_dump(), indent=2))
    
    # Reinitialize motor manager with new config
    motor_mgr.disconnect_all()
    for idx, motor_cfg in enumerate(motor_file.motors):
        if motor_cfg.include:
            motor_mgr.add_motor(idx, motor_cfg.model_dump())
    
    print("[MCC-Hub] Motors updated")
    return {"ok": True}

@app.get("/api/motors/ports")
def get_serial_ports():
    """List available COM ports"""
    return {"ports": list_serial_ports()}


@app.get("/api/logic_elements")
def get_logic_elements():
    """Get logic element configuration"""
    if LE_PATH.exists():
        try:
            return json.loads(LE_PATH.read_text())
        except:
            pass
    return {"elements": []}

@app.put("/api/logic_elements")
def put_logic_elements(data: LEFile):
    """Update logic element configuration"""
    try:
        LE_PATH.write_text(json.dumps(data.dict(), indent=2))
        load_le()
        return {"ok": True}
    except Exception as e:
        return {"ok": False, "error": str(e)}

@app.get("/api/math_operators")
def get_math_operators():
    """Get math operator configuration"""
    if MATH_PATH.exists():
        try:
            return json.loads(MATH_PATH.read_text())
        except:
            pass
    return {"operators": []}

@app.put("/api/math_operators")
def put_math_operators(data: MathOpFile):
    """Update math operator configuration"""
    try:
        MATH_PATH.write_text(json.dumps(data.model_dump(), indent=2))
        load_math()
        return {"ok": True}
    except Exception as e:
        return {"ok": False, "error": str(e)}

@app.post("/api/motors/{index}/rpm")
def set_motor_rpm(index: int, body: dict):
    """Manually set motor RPM"""
    rpm = body.get("rpm", 0.0)
    success = motor_mgr.set_motor_rpm(index, rpm)
    return {"ok": success}

@app.post("/api/motors/{index}/enable")
def enable_motor(index: int):
    """Enable motor"""
    global motor_file
    
    if index >= len(motor_file.motors):
        return {"ok": False, "error": "Motor index out of range"}
    
    # Update the enabled flag in config
    motor_file.motors[index].enabled = True
    MOTOR_PATH.write_text(json.dumps(motor_file.model_dump(), indent=2))
    
    # Enable hardware if motor is in manager
    if index in motor_mgr.motors:
        success = motor_mgr.motors[index].enable_motor()
        return {"ok": success, "enabled": True}
    
    return {"ok": True, "enabled": True, "note": "Config updated, motor not initialized (check include)"}

@app.post("/api/motors/{index}/disable")
def disable_motor(index: int):
    """Disable motor"""
    global motor_file
    
    if index >= len(motor_file.motors):
        return {"ok": False, "error": "Motor index out of range"}
    
    # Update the enabled flag in config
    motor_file.motors[index].enabled = False
    MOTOR_PATH.write_text(json.dumps(motor_file.model_dump(), indent=2))
    
    # Disable hardware and stop motor
    if index in motor_mgr.motors:
        # Send stop command (0 RPM)
        motor_mgr.set_motor_rpm(index, 0, motor_file.motors[index].cw_positive)
        success = motor_mgr.motors[index].disable_motor()
        return {"ok": success, "enabled": False}
    
    return {"ok": True, "enabled": False, "note": "Config updated, motor not initialized (check include)"}

@app.get("/api/motors/{index}/status")
def get_motor_status(index: int):
    """Get motor status"""
    status = motor_mgr.get_motor_status(index)
    if status:
        return status
    return {"error": "Motor not found"}

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
    idx = req.index
    target_state = req.state
    active_high = req.active_high
    #print(f"[CMD] DO{idx} <- {target_state} (active_high={active_high})")
    
    # Check if this DO is gated by a logic element
    try:
        cfg = mcc.cfg
        if idx < len(cfg.digitalOutputs):
            do_cfg = cfg.digitalOutputs[idx]
            le_index = getattr(do_cfg, "logicElement", None)
            
            if le_index is not None and 0 <= le_index < len(le_mgr.outputs):
                le_output = le_mgr.get_output(le_index)
                if not le_output:
                    log.info(f"[DO] DO{idx} blocked by LE{le_index} (LE output is False)")
                    return {"ok": False, "reason": f"Blocked by LE{le_index}"}
    except Exception as e:
        log.error(f"[DO] Error checking LE gate: {e}")
    
    mcc.set_do(idx, target_state, active_high=active_high)
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
    global ao_desired_values
    
    # Always update the desired value
    if 0 <= req.index < len(ao_desired_values):
        ao_desired_values[req.index] = req.volts
    
    # Check if this AO has enable gating
    ao_cfg = app_cfg.analogOutputs[req.index] if req.index < len(app_cfg.analogOutputs) else None
    
    if ao_cfg and ao_cfg.enable_gate:
        # Check the gate signal
        enable_signal = False
        
        if ao_cfg.enable_kind == "do":
            do_snapshot = mcc.get_do_snapshot()
            if ao_cfg.enable_index < len(do_snapshot):
                enable_signal = bool(do_snapshot[ao_cfg.enable_index])
        elif ao_cfg.enable_kind == "le":
            le_tel = le_mgr.get_telemetry()
            if ao_cfg.enable_index < len(le_tel):
                enable_signal = le_tel[ao_cfg.enable_index].get("output", False)
        
        # Only write to hardware if enabled
        if enable_signal:
            mcc.set_ao(req.index, req.volts)
        else:
            # Gate is disabled - don't write, keep at 0V
            mcc.set_ao(req.index, 0.0)
    else:
        # No gating, write directly
        mcc.set_ao(req.index, req.volts)
    
    return {"ok": True}

@app.post("/api/zero_ai")
async def zero_ai_channels(req: dict):
    """Zero AI channels by averaging and adjusting offset"""
    
    channels = req.get("channels", [])
    averaging_period = req.get("averaging_period", 1.0)
    balance_to_value = req.get("balance_to_value", 0.0)  # Value to balance to (default: 0)
    
    if not channels:
        return {"ok": False, "error": "No channels specified"}
    
    # Validate channels
    for ch in channels:
        if ch < 0 or ch >= len(app_cfg.analogs):
            return {"ok": False, "error": f"Invalid channel index: {ch}"}
    
    # Collect samples from the acquisition loop
    samples = {ch: [] for ch in channels}
    start_time = time.time()
    sample_count = 0
    
    # Wait and collect samples
    while time.time() - start_time < averaging_period:
        await asyncio.sleep(0.01)  # 10ms between checks
        sample_count += 1
        
        # Read directly from hardware (scaled values)
        try:
            ai_raw = mcc.read_ai_all()
            for ch in channels:
                if ch < len(ai_raw):
                    # Apply current scaling to get what the user sees
                    cfg = app_cfg.analogs[ch]
                    val = ai_raw[ch] * cfg.slope + cfg.offset
                    if math.isfinite(val):
                        samples[ch].append(val)
        except Exception as e:
            print(f"[Zero-AI] Sample error: {e}")
            continue
    
    # Calculate averages and update offsets
    offsets = []
    for ch in channels:
        if not samples[ch]:
            return {"ok": False, "error": f"No valid samples for channel {ch}"}
        
        avg = sum(samples[ch]) / len(samples[ch])
        old_offset = app_cfg.analogs[ch].offset
        
        # Calculate new offset: we want (raw * slope + new_offset) = balance_to_value
        # Currently: (raw * slope + old_offset) = avg
        # So: raw * slope = avg - old_offset
        # We want: (avg - old_offset) + new_offset = balance_to_value
        # Therefore: new_offset = balance_to_value - avg + old_offset
        # Simplified: new_offset = old_offset - (avg - balance_to_value)
        new_offset = old_offset - (avg - balance_to_value)
        
        # Update config
        app_cfg.analogs[ch].offset = new_offset
        
        offsets.append({
            "channel": ch,
            "old": old_offset,
            "new": new_offset,
            "avg": avg,
            "balance_to": balance_to_value,
            "samples": len(samples[ch])
        })
    
    # Save config to disk
    CFG_PATH.write_text(json.dumps(app_cfg.model_dump(), indent=2))
    print(f"[Zero-AI] Updated offsets for {len(channels)} channel(s)")
    
    return {"ok": True, "offsets": offsets}

# ---------- REST: logs ----------
@app.get("/api/logs")
def list_logs():
    return sorted([p.name for p in LOGS_DIR.glob("*") if p.is_dir()])

@app.post("/api/logs/close")
def close_log():
    """Close current log and start a new one"""
    global session_logger
    if session_logger:
        session_logger.close()
        session_logger = None
        
        # Create new session
        session_id = datetime.now().strftime("%Y%m%d_%H%M%S")
        session_dir = LOGS_DIR / session_id
        session_dir.mkdir(parents=True, exist_ok=True)
        session_logger = SessionLogger(session_dir)
        
        return {"ok": True, "message": f"Log closed and new session started: {session_id}", "session_id": session_id}
    else:
        return {"ok": False, "message": "No active log to close"}

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
