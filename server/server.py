"""
Version: 1.0.0
Updated: 2026-01-14 23:30:56
"""
__version__ = "5.28.3"  # Keep min buffer (1000 samples) for pre-trigger, don't drain buffer completely
__updated__ = "2026-01-14 23:30:56"


# server/server.py
# Python 3.10+
import asyncio, json, time, os, sys
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional
from collections import deque
from threading import Lock, Thread, Event
import threading  # For threading.Event() in expressions
from concurrent.futures import ThreadPoolExecutor

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
from acq_scope import ScopeProcessor  # Scope mode acquisition & trigger detection
from app_models import (
    AppConfig, get_all_analogs, get_all_digital_outputs,
    get_all_analog_outputs, get_all_thermocouples,
    migrate_config_to_board_centric,
    PIDFile, ScriptFile, MotorFile, default_config
)
from motor_controller import MotorManager, list_serial_ports
from logic_elements import LEManager
from math_ops import MathOpManager, MathOpFile
from app_models import LEFile, LogicElementCfg
from expr_manager import ExpressionManager
from expr_engine import Lexer, Parser, Evaluator  # For pre-compilation
from expr_engine import global_vars as expr_global_vars
import logging, os, math


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
print(f"[MCC-Hub] Server version {__version__} (updated: {__updated__})")
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
        "server": __version__,
        "bridge": BRIDGE_VERSION,
        "have_mcculw": bool(HAVE_MCCULW),
        "have_uldaq": bool(HAVE_ULDAQ),
        "board1608": b1608,
        "boardetc": betc,
    }

@app.get("/api/version")
def get_version():
    """Get version info for all components"""
    try:
        import expr_engine
        import expr_manager
        expr_engine_ver = getattr(expr_engine, '__version__', 'unknown')
        expr_manager_ver = getattr(expr_manager, '__version__', 'unknown')
    except:
        expr_engine_ver = 'not loaded'
        expr_manager_ver = 'not loaded'
    
    return {
        "server": __version__,
        "updated": __updated__,
        "bridge": BRIDGE_VERSION,
        "expr_engine": expr_engine_ver,
        "expr_manager": expr_manager_ver,
        "python": sys.version.split()[0],
        "platform": sys.platform
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

@app.get("/EXPRESSION_REFERENCE.md")
def _expression_reference():
    ref_file = WEB_DIR / "EXPRESSION_REFERENCE.md"
    if ref_file.exists():
        return FileResponse(str(ref_file), media_type="text/markdown")
    # Fallback if file doesn't exist
    return {"error": "EXPRESSION_REFERENCE.md not found in web directory"}

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

# Global rate variables (will be loaded from config below)
acq_rate_hz: float = 100.0  # Effective acquisition rate (for roll mode / general use)
hw_sample_rate_hz: float = 100.0  # Hardware sampling rate (for scope mode burst)
TARGET_UI_HZ: float = 25.0  # Default display update rate

# Scope mode trigger state
scope_trigger_state = {
    'enabled': False,
    'mode': 'auto',  # 'auto', 'normal', 'single'
    'source_index': 0,  # Which AI channel to trigger on
    'level': 0.0,
    'edge': 'rising',  # 'rising' or 'falling'
    'position': 50,  # 0-100% where trigger appears on display
    'armed': True,
    'last_trigger_time': 0.0,
    'max_update_rate_hz': 200.0,  # Max display updates in auto mode
}

# Scope processor instance (will be initialized in acq_loop)
scope_processor: Optional[ScopeProcessor] = None

app_cfg = _load_json_model(CFG_PATH, AppConfig)
app_cfg = migrate_config_to_board_centric(app_cfg)  # Auto-migrate old configs

# Load acquisition rate from first enabled board
if app_cfg.boards1608:
    for board in app_cfg.boards1608:
        if board.enabled:
            acq_rate_hz = max(1.0, board.sampleRateHz)
            hw_sample_rate_hz = acq_rate_hz  # Default to same
            print(f"[MCC-Hub] Loaded acquisition rate from config: {acq_rate_hz} Hz")
            print(f"[MCC-Hub] Hardware sample rate: {hw_sample_rate_hz} Hz")
            break

# Load display rate from config
if app_cfg.display_rate_hz:
    TARGET_UI_HZ = app_cfg.display_rate_hz
    print(f"[MCC-Hub] Loaded display rate from config: {TARGET_UI_HZ} Hz")

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

# Math Operators
math_mgr = MathOpManager()
MATH_PATH = CFG_DIR / "math_operators.json"

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

# Expression Manager
expr_mgr = ExpressionManager(filepath=str(CFG_DIR / "expressions.json"))
log.info(f"[EXPR] Loaded {len(expr_mgr.expressions)} expressions")

# PRE-COMPILE EXPRESSIONS FOR FAST EVALUATION
# Cache the parsed AST for each expression to avoid re-parsing every evaluation
expr_ast_cache = {}
for i, expr in enumerate(expr_mgr.expressions):
    try:
        lexer = Lexer(expr.expression)
        tokens = lexer.tokenize()
        parser = Parser(tokens)
        ast = parser.parse()
        expr_ast_cache[i] = ast
        log.info(f"[EXPR] Pre-compiled: {expr.name}")
    except Exception as e:
        log.error(f"[EXPR] Failed to pre-compile '{expr.name}': {e}")
        expr_ast_cache[i] = None

log.info(f"[EXPR] Pre-compiled {len(expr_ast_cache)} expressions")

# Fast evaluation using pre-compiled AST
def evaluate_compiled_expressions(signal_state, bridge=None, sample_rate_hz=25.0):
    """
    Evaluate expressions using pre-compiled AST cache (100x faster than parsing each time)
    """
    telemetry = []
    
    for i, expr in enumerate(expr_mgr.expressions):
        if not expr.enabled:
            expr_mgr.outputs[i] = 0.0
            expr_mgr.tick_counters[i] = 0
            telemetry.append({
                'name': expr.name,
                'output': 0.0,
                'enabled': False,
                'error': None
            })
            continue
        
        # Check decimation
        should_execute = True
        if expr.execution_rate_hz is not None and expr.execution_rate_hz > 0:
            decimate = max(1, int(round(sample_rate_hz / expr.execution_rate_hz)))
            expr_mgr.tick_counters[i] += 1
            should_execute = (expr_mgr.tick_counters[i] >= decimate)
            if should_execute:
                expr_mgr.tick_counters[i] = 0
        
        if not should_execute:
            # Return cached telemetry
            cached = expr_mgr.last_telemetry[i].copy() if i < len(expr_mgr.last_telemetry) else {}
            cached['skipped'] = True
            telemetry.append(cached)
            continue
        
        # Use pre-compiled AST
        ast = expr_ast_cache.get(i)
        if ast is None:
            # Compilation failed, skip
            telemetry.append({
                'name': expr.name,
                'output': 0.0,
                'error': 'Pre-compilation failed',
                'skipped': False
            })
            continue
        
        try:
            # Evaluate using cached AST (no parsing!)
            t_eval_start = time.perf_counter()
            evaluator = Evaluator(signal_state)
            result = evaluator.evaluate(ast)
            t_eval = (time.perf_counter() - t_eval_start) * 1000
            
            if t_eval > 5:
                print(f"[EXPR-SLOW] '{expr.name}' evaluation took {t_eval:.1f}ms")
            
            expr_mgr.outputs[i] = result
            signal_state['expr'] = expr_mgr.outputs.copy()
            
            # Apply hardware writes (NON-BLOCKING - use thread pool)
            if bridge and evaluator.hardware_writes:
                for write in evaluator.hardware_writes:
                    try:
                        # Cache key: type + channel
                        cache_key = f"{write['type']}_{write['channel']}"
                        
                        # Check if value changed
                        if not hasattr(evaluate_compiled_expressions, 'hw_cache'):
                            evaluate_compiled_expressions.hw_cache = {}
                        
                        if evaluate_compiled_expressions.hw_cache.get(cache_key) != write['value']:
                            # Value changed - write to hardware
                            
                            # Check if this is a blocking DO write (pauses AI acquisition)
                            is_blocking_do = False
                            if write['type'] == 'do':
                                # Check if this DO is configured as blocking
                                channel = write['channel']
                                for board_cfg in app_cfg.boards1608:
                                    if not board_cfg.enabled:
                                        continue
                                    for do_cfg in board_cfg.digitalOutputs:
                                        board_idx = app_cfg.boards1608.index(board_cfg)
                                        do_idx = board_cfg.digitalOutputs.index(do_cfg)
                                        global_do_idx = board_idx * 8 + do_idx
                                        blocking_val = getattr(do_cfg, 'blocking', False)
                                        if global_do_idx == channel and blocking_val:
                                            is_blocking_do = True
                                            break
                                    if is_blocking_do:
                                        break
                            
                            # Pause burst if blocking
                            if is_blocking_do:
                                print(f"[BLOCKING] Pausing burst for DO{write['channel']}")
                                burst_paused.set()  # Pause burst acquisition
                            
                            # Write to hardware
                            t_hw_start = time.perf_counter()
                            if write['type'] == 'do':
                                bridge.set_do(write['channel'], write['value'], active_high=True)
                            elif write['type'] == 'ao':
                                bridge.set_ao(write['channel'], write['value'])
                            t_hw_elapsed = (time.perf_counter() - t_hw_start) * 1000
                            
                            # Resume burst if we paused it
                            if is_blocking_do:
                                burst_paused.clear()
                                print(f"[BLOCKING] Resumed burst after {t_hw_elapsed:.1f}ms")
                            
                            if t_hw_elapsed > 5:
                                mode = " (BLOCKING)" if is_blocking_do else ""
                                print(f"[HW-TIMING] {write['type'].upper()}{write['channel']} write took {t_hw_elapsed:.1f}ms{mode}")
                            
                            # Update cache
                            evaluate_compiled_expressions.hw_cache[cache_key] = write['value']
                    except Exception as e:
                        print(f"[EXPR] Hardware write failed: {e}")
            
            # Build telemetry
            tel = {
                'name': expr.name,
                'output': result,
                'enabled': True,
                'error': None,
                'skipped': False,
                'locals': evaluator.local_vars,
                'branches': evaluator.branch_paths,
                'executed_lines': list(evaluator.executed_lines)
            }
            expr_mgr.last_telemetry[i] = tel
            telemetry.append(tel)
            
        except Exception as e:
            telemetry.append({
                'name': expr.name,
                'output': 0.0,
                'error': str(e),
                'skipped': False
            })
    
    return telemetry


# Button variables storage (synchronized from frontend)
button_vars: Dict[str, float] = {}

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
# Note: acq_rate_hz and TARGET_UI_HZ are loaded from config earlier (around line 270)
_need_reconfig_filters = False

@app.on_event("startup")
def _on_startup():
    print("[MCC-Hub] FastAPI startup")
    # Print versions for verification
    import app_models
    import mcc_bridge
    print(f"[VERSIONS] server.py: {__version__}")
    print(f"[VERSIONS] app_models.py: {getattr(app_models, '__version__', 'unknown')}")
    print(f"[VERSIONS] mcc_bridge.py: {getattr(mcc_bridge, '__version__', 'unknown')}")

@app.on_event("shutdown")
def _on_shutdown():
    print("[MCC-Hub] FastAPI shutdown")
    motor_mgr.disconnect_all()
    print("[MCC-Hub] Motors disconnected")

async def broadcast(msg: dict):
    # Offload JSON serialization to thread pool (CPU-bound)
    loop = asyncio.get_event_loop()
    try:
        txt = await loop.run_in_executor(
            json_executor,
            lambda: json.dumps(msg, separators=(",", ":"))
        )
    except Exception as e:
        print(f"[WS] JSON serialization failed: {e}")
        print(f"[WS] Message type: {msg.get('type')}")
        import traceback
        traceback.print_exc()
        return
    
    living = []
    sent_count = 0
    for ws in ws_clients:
        try:
            await ws.send_text(txt)
            living.append(ws)
            sent_count += 1
        except Exception as e:
            # Client disconnected
            print(f"[WS] Client send failed: {e}")
            pass
    ws_clients[:] = living
    if sent_count == 0 and len(ws_clients) > 0:
        print(f"[WS] WARNING: Had {len(ws_clients)} clients but sent to 0!")

# ========== BURST MODE GLOBALS ==========
sample_buffer = deque(maxlen=2000)  # Larger buffer to reduce lock contention
processed_scope_buffer = deque(maxlen=20000)  # Processed samples for scope trigger detection (larger for pre-trigger)

def detect_scope_trigger(buffer, trigger_state):
    """
    Search buffer for trigger event
    
    Returns: (triggered, trigger_index) where trigger_index is position in buffer
    """
    if not trigger_state['armed'] or len(buffer) < 10:
        return False, -1
    
    source_idx = trigger_state['source_index']
    level = trigger_state['level']
    edge = trigger_state['edge']
    
    # Search backward through buffer (newest first)
    for i in range(len(buffer) - 1, 0, -1):
        try:
            cur_sample = buffer[i]
            prev_sample = buffer[i - 1]
            
            if 'ai' not in cur_sample or 'ai' not in prev_sample:
                continue
            
            if source_idx >= len(cur_sample['ai']) or source_idx >= len(prev_sample['ai']):
                continue
            
            cur_val = cur_sample['ai'][source_idx]
            prev_val = prev_sample['ai'][source_idx]
            
            # Check trigger condition
            if edge == 'rising':
                if prev_val < level and cur_val >= level:
                    return True, i
            else:  # falling
                if prev_val > level and cur_val <= level:
                    return True, i
                    
        except (KeyError, IndexError):
            continue
    
    return False, -1
buffer_lock = Lock()
burst_rate_hz = 1000  # Hardware burst acquisition rate
burst_running = Event()  # Signal to stop acquisition thread
burst_paused = Event()   # Signal to pause acquisition for blocking DO writes
burst_paused.clear()     # Not paused by default
acquisition_thread = None  # Background acquisition thread

# Thread pool for offloading JSON serialization (CPU-bound operation)
json_executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="json-")

"""
BURST MODE ACQUISITION THREAD
Insert this BEFORE the acq_loop() function
"""

def burst_acquisition_thread():
    """
    Background thread that reads bursts from hardware
    Paces itself to match the requested acquisition rate
    
    ONLY acquires from boards with AI channels configured (skips DO-only boards)
    """
    global sample_buffer, burst_running, acq_rate_hz, hw_sample_rate_hz, TARGET_UI_HZ
    
    print("[BURST] Acquisition thread starting")
    
    # Determine which boards to acquire from (skip DO-only boards)
    # For now, hardcode to board #2 only (skip #0)
    ai_boards = [2]  # TODO: Auto-detect from config
    print(f"[BURST] Acquiring from boards: {ai_boards}")
    
    burst_count = 0
    error_count = 0
    last_stats = time.perf_counter()
    last_burst = time.perf_counter()
    
    try:
        while burst_running.is_set():
            try:
                # Use hw_sample_rate_hz for actual hardware sampling
                # Calculate block size: aim for ~100-200ms of data
                # At 10kHz: 1000-2000 samples
                # At 100kHz: 10000-20000 samples
                # Min 20 samples for low rates
                target_block_time = 0.1  # 100ms blocks
                block_size = max(20, int(hw_sample_rate_hz * target_block_time))
                
                if burst_count == 0:
                    actual_burst_rate = 1.0 / target_block_time
                    print(f"[BURST] Block size: {block_size} samples ({target_block_time*1000:.0f}ms each) for {hw_sample_rate_hz} Hz hardware rate")
                    print(f"[BURST] Burst rate: {actual_burst_rate:.1f} bursts/sec")
                
                burst_interval = block_size / max(1.0, hw_sample_rate_hz)  # seconds between bursts
                
                # Wait until it's time for next burst
                now = time.perf_counter()
                time_since_last = now - last_burst
                if time_since_last < burst_interval:
                    time.sleep(burst_interval - time_since_last)
                
                last_burst = time.perf_counter()
                
                # Check if blocking DO write is happening
                if burst_paused.is_set():
                    time.sleep(0.001)  # Wait 1ms for DO to complete
                    continue
                
                # Read burst from hardware (ONLY from AI boards, skip DO-only boards)
                try:
                    # Try passing samples parameter if supported
                    burst_samples = mcc.read_ai_all_burst(rate_hz=int(hw_sample_rate_hz), samples=block_size, board_filter=ai_boards)
                except TypeError:
                    # Fallback if params not supported
                    burst_samples = mcc.read_ai_all_burst(rate_hz=int(hw_sample_rate_hz))
                
                # Add all samples to ring buffer (thread-safe)
                with buffer_lock:
                    for sample in burst_samples:
                        sample_buffer.append(sample)
                
                burst_count += 1
                
                # Stats every 5 seconds
                now = time.perf_counter()
                if now - last_stats > 5.0:
                    elapsed = now - last_stats
                    samples_acquired = burst_count * block_size  # Use current block_size
                    actual_sample_rate = samples_acquired / elapsed
                    buffer_size = len(sample_buffer)
                    
                    efficiency = (actual_sample_rate / hw_sample_rate_hz * 100) if hw_sample_rate_hz > 0 else 0
                    print(f"[BURST] Sample rate: {actual_sample_rate:.1f} Hz ({efficiency:.0f}% of target {hw_sample_rate_hz} Hz) | Buffer: {buffer_size} | Bursts: {burst_count} | Errors: {error_count}")
                    
                    burst_count = 0
                    error_count = 0
                    last_stats = now
                
            except Exception as e:
                error_count += 1
                if error_count < 5:
                    print(f"[BURST] Acquisition error: {e}")
                time.sleep(0.01)
                
    except Exception as e:
        print(f"[BURST] Acquisition thread crashed: {e}")
        import traceback
        traceback.print_exc()
    finally:
        print("[BURST] Acquisition thread stopped")


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
    global session_logger, _need_reconfig_filters, TARGET_UI_HZ

    # Target UI update rate (for charts/widgets)
    # BURST MODE: Smooth UI (decoupled from acquisition)
    # Use global TARGET_UI_HZ so API changes take effect
    # Max TC read rate; TCs are slow, don't hammer them every AI sample
    TC_RATE_HZ = 10.0

    ticks = 0
    log_ctr = 0
    bcast_ctr = 0

    print(f"[MCC-Hub] Acquisition loop starting @ {acq_rate_hz} Hz")
    last = time.perf_counter()

    # Prepare filters from config
    all_analogs = get_all_analogs(app_cfg)
    cutoff_list = [a.cutoffHz for a in all_analogs]
    lpf.configure(
        rate_hz=acq_rate_hz,
        cutoff_list=cutoff_list,
    )
    lpf_tc.configure(
        rate_hz=acq_rate_hz,
        cutoff_list=[tc.cutoffHz for tc in get_all_thermocouples(app_cfg)],
    )

    # Start session logging folder
    session_dir = LOGS_DIR / datetime.now().strftime("%Y%m%d_%H%M%S")
    session_dir.mkdir(parents=True, exist_ok=True)
    session_logger = SessionLogger(session_dir)
    await broadcast({"type": "session", "dir": session_dir.name})
    print(f"[MCC-Hub] Logging to {session_dir}")
    
    # Initialize scope processor
    global scope_processor
    scope_processor = ScopeProcessor(broadcast_func=broadcast)
    print("[MCC-Hub] Scope processor initialized")

    # Start hardware
    try:
        mcc.open(app_cfg)
        print("[MCC-Hub] Hardware open() complete")
        
        # Initialize analog outputs to startup values
        # Set multiple times because hardware may reset to default (often 1V for AO0)
        print("[MCC-Hub] Initializing AOs to startup values...")
        for attempt in range(3):  # Try 3 times
            for i, ao_cfg in enumerate(get_all_analog_outputs(app_cfg)):
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
        
        # Start background acquisition thread
        global burst_running, acquisition_thread
        burst_running.set()
        acquisition_thread = Thread(target=burst_acquisition_thread, daemon=True)
        acquisition_thread.start()
        print("[MCC-Hub] Background acquisition thread started")
        
    except Exception as e:
        print(f"[MCC-Hub] Hardware open() failed: {e}")

    # TC throttling state
    last_tc_vals: List[float] = []
    last_tc_time = time.perf_counter()
    min_tc_interval = 1.0 / max(1.0, TC_RATE_HZ)
    
    # PID telemetry from previous cycle (for cascade control)
    last_pid_telemetry: List[Dict] = []
    math_tel: List[Dict] = []
    last_expr_outputs: List[float] = []
    expr_tel: List[Dict] = []

    try:
        # === TIMER-DRIVEN PROCESSING ===
        # Main loop runs at display rate (TARGET_UI_HZ)
        # Each iteration processes ALL available samples (event-driven, not timer-driven)
        print(f"[MCC-Hub] Event-driven mode: Processing samples as fast as they arrive")
        print(f"[MCC-Hub] Hardware: {hw_sample_rate_hz} Hz | Display updates: max {TARGET_UI_HZ} Hz")
        
        while True:
            # Short sleep to yield CPU, but process as fast as possible
            await asyncio.sleep(0.001)  # 1ms sleep between cycles
            
            display_start = time.perf_counter()
            
            # Check how many samples are available
            with buffer_lock:
                available_samples = len(sample_buffer)
            
            # Skip if buffer empty
            if available_samples == 0:
                continue
            
            # Skip if buffer too small (startup warmup)
            if ticks < 10 and available_samples < 100:
                if ticks % 5 == 0:
                    print(f"[STARTUP] Waiting for buffer to fill... ({available_samples} samples)")
                continue
            
            # CRITICAL: Keep enough samples for pre-trigger!
            # In scope mode, we need to maintain a buffer for pre-trigger samples
            # Leave at least 2x the expected samples needed for a full sweep
            min_buffer_retain = 1000  # Keep at least 1000 samples for pre-trigger
            
            if available_samples <= min_buffer_retain:
                # Buffer too small - don't process yet
                continue
            
            # Process samples but leave min_buffer_retain in buffer
            samples_to_grab = available_samples - min_buffer_retain
            
            if samples_to_grab == 0:
                # Buffer empty - skip this cycle
                continue
            
            # Debug at low rates
            if TARGET_UI_HZ <= 5.0:
                print(f"[CYCLE-START] Will grab {samples_to_grab} samples from buffer of {available_samples}")

            # Initialize expr telemetry - will be populated after sample loop
            batch_expr_tel = []


            frames_this_cycle = []
            
            for sample_idx in range(samples_to_grab):
                sample_start = time.perf_counter()
                t1 = sample_start
                
                # --- SINGLE SAMPLE PROCESSING (same as before) ---

                # Reconfigure LPF if rate changed
                if _need_reconfig_filters:
                    lpf.configure(
                        rate_hz=acq_rate_hz,
                        cutoff_list=[a.cutoffHz for a in get_all_analogs(app_cfg)],
                    )
                    lpf_tc.configure(
                        rate_hz=acq_rate_hz,
                        cutoff_list=[tc.cutoffHz for tc in get_all_thermocouples(app_cfg)],
                    )
                    _need_reconfig_filters = False
                    print(f"[MCC-Hub] Reconfigured LPF for rate {acq_rate_hz} Hz")
                
                t2 = time.perf_counter()

                # --- Get one sample from buffer ---
                # Buffer should stay near zero if processing rate matches acquisition
                with buffer_lock:
                    buffer_size = len(sample_buffer)
                
                    if buffer_size == 0:
                        # Buffer empty - skip this sample (acquisition warming up)
                        continue  # Skip to next sample
                    else:
                        ai_raw = sample_buffer.popleft()
                    
                        # Monitor buffer health (removed debug print)
                
                t3 = time.perf_counter()
                
                if (t3 - t2) > 0.01:  # If buffer access took >10ms
                    print(f"[TIMING-DEBUG] Buffer access took {(t3-t2)*1000:.1f}ms with {buffer_size} samples in buffer")

                # --- Read TCs at a much lower rate ---
                now_tc = time.perf_counter()
                if now_tc - last_tc_time >= min_tc_interval:
                    try:
                        last_tc_vals = mcc.read_tc_all()
                    except Exception as e:
                        print(f"[MCC-Hub] TC read failed: {e}")
                        # keep last_tc_vals as-is on failure
                    last_tc_time = now_tc
            
                t4 = time.perf_counter()
                if (t4 - t3) > 0.01:
                    print(f"[TIMING-DEBUG] TC section took {(t4-t3)*1000:.1f}ms")
            
                # Apply offset and LPF to TC values
                tc_vals: List[float] = []
                for i, raw in enumerate(last_tc_vals):
                    try:
                        offset = get_all_thermocouples(app_cfg)[i].offset if i < len(get_all_thermocouples(app_cfg)) else 0.0
                        val = raw + offset
                        val = lpf_tc.apply(i, val)
                        tc_vals.append(val)
                    except Exception:
                        tc_vals.append(raw)

                # --- Scale + LPF AI values ---
                ai_scaled: List[float] = []
                for i, raw in enumerate(ai_raw):
                    try:
                        m = get_all_analogs(app_cfg)[i].slope
                        b = get_all_analogs(app_cfg)[i].offset
                    except Exception:
                        m, b = 1.0, 0.0
                    y = m * raw + b
                    y = lpf.apply(i, y)
                    ai_scaled.append(y)

                # Get DO/AO snapshot BEFORE PID and LE evaluation
                # (needed for both LE inputs and PID gate checking)
                ao = mcc.get_ao_snapshot()
                do = mcc.get_do_snapshot()
                
                t5 = time.perf_counter()
                if (t5 - t4) > 0.01:
                    print(f"[TIMING-DEBUG] AI scaling + DO/AO took {(t5-t4)*1000:.1f}ms")

                # --- Math Operators ---
                t_math_start = time.perf_counter()
                # Evaluate first so LEs can use math outputs
                # Use previous cycle's PID data (avoids circular dependency)
                math_tel = math_mgr.evaluate_all({
                    "ai": ai_scaled,
                    "ao": ao,
                    "tc": tc_vals,
                    "pid": last_pid_telemetry,  # Previous cycle PID data
                    "le": []    # LEs haven't been evaluated with math yet
                }, bridge=mcc)
                t_math = time.perf_counter() - t_math_start

                # --- Logic Elements ---
                t_le_start = time.perf_counter()
                # Evaluate AFTER Math but BEFORE PIDs so PIDs can use LE outputs as enable gates
                le_outputs = le_mgr.evaluate_all({
                    "ai": ai_scaled,
                    "ao": ao,
                    "do": do,
                    "tc": tc_vals,
                    "pid": [],  # PIDs haven't run yet
                    "math": math_tel  # Now LEs can use math outputs
                })
                le_tel = le_mgr.get_telemetry()
                t_le = time.perf_counter() - t_le_start

                # --- PIDs (may drive DO/AO) ---
                t_pid_start = time.perf_counter()
                # Pass DO/LE/Math/Expr state so PIDs can use them
                # Pass previous cycle's PID and Expr telemetry for inputs/gates
                telemetry = pid_mgr.step(
                    ai_vals=ai_scaled,
                    tc_vals=tc_vals,
                    bridge=mcc,
                    do_state=do,
                    le_state=le_tel,  # Now has updated LE state with math
                    pid_prev=last_pid_telemetry,
                    math_outputs=[m.get("output", 0.0) for m in math_tel],
                    expr_outputs=last_expr_outputs,  # Previous cycle's expression outputs
                    sample_rate_hz=acq_rate_hz
                )
            
                # Store for next cycle
                last_pid_telemetry = telemetry
                t_pid = time.perf_counter() - t_pid_start

                # --- Logic Elements (Re-evaluation) ---
                # Re-evaluate LEs after PIDs so LEs can use PID outputs as inputs
                le_outputs = le_mgr.evaluate_all({
                    "ai": ai_scaled,
                    "ao": ao,
                    "do": do,
                    "tc": tc_vals,
                    "pid": telemetry,
                    "math": math_tel  # Keep math available
                })
                le_tel = le_mgr.get_telemetry()

                # Expressions moved outside loop - evaluated once per batch
                expr_tel = []  # Will be populated after loop
                # --- Logic Elements (Third pass - can now see expressions) ---
                # Re-evaluate LEs one more time so they can use expression outputs
                le_outputs = le_mgr.evaluate_all({
                    "ai": ai_scaled,
                    "ao": ao,
                    "do": do,
                    "tc": tc_vals,
                    "pid": telemetry,
                    "math": math_tel,
                    "expr": last_expr_outputs  # Use previous batch expressions
                })
                le_tel = le_mgr.get_telemetry()

                # --- AO Enable Gating ---
                # Check gates and apply/restore values as needed
                global ao_desired_values, ao_last_gate_state
            
                for i, ao_cfg in enumerate(get_all_analog_outputs(app_cfg)):
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
                        elif ao_cfg.enable_kind == "math":
                            if ao_cfg.enable_index < len(math_tel):
                                enable_signal = math_tel[ao_cfg.enable_index].get("output", 0.0) >= 1.0
                        elif ao_cfg.enable_kind == "expr":
                            if ao_cfg.enable_index < len(last_expr_outputs):
                                enable_signal = last_expr_outputs[ao_cfg.enable_index] >= 1.0
                    
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

                # Convert NaN/Infinity to None for JSON serialization
                t6 = time.perf_counter()
                
                # Print detailed timing if anything is slow (expressions moved outside loop)
                total_eval_time = (t6 - t5) * 1000
                if total_eval_time > 10:
                    print(f"[TIMING-DETAIL] Math:{t_math*1000:.1f}ms LE:{t_le*1000:.1f}ms PID:{t_pid*1000:.1f}ms (no Expr) Total:{total_eval_time:.1f}ms")
                
                def clean_for_json(obj):
                    if isinstance(obj, float):
                        return None if not math.isfinite(obj) else obj
                    elif isinstance(obj, list):
                        return [clean_for_json(item) for item in obj]
                    elif isinstance(obj, dict):
                        return {k: clean_for_json(v) for k, v in obj.items()}
                    return obj

                # Generate synthetic triangle wave (1 second period)
                # Use sample counter for perfect spacing (not wall-clock time)
                # This ensures each sample gets a unique value regardless of processing speed
                if not hasattr(acq_loop, 'triangle_sample_count'):
                    acq_loop.triangle_sample_count = 0
                
                # Calculate phase based on sample count and acquisition rate
                # At 1000 Hz, 1000 samples = 1 second period
                phase = (acq_loop.triangle_sample_count / acq_rate_hz) % 1.0
                if phase < 0.5:
                    triangle_value = phase * 2.0  # Rising: 0 to 1
                else:
                    triangle_value = 2.0 - phase * 2.0  # Falling: 1 to 0
                
                acq_loop.triangle_sample_count += 1
                
                # Add synthetic signal to ai_scaled list
                ai_with_synthetic = list(ai_scaled) + [triangle_value]

                frame = {
                    "type": "tick",
                    "t": time.time(),
                    "ai": clean_for_json(ai_with_synthetic),  # Include synthetic signal
                    "ao": clean_for_json(ao),
                    "do": do,
                    "tc": clean_for_json(tc_vals),
                    "pid": clean_for_json(telemetry),
                    "motors": clean_for_json(motor_status),
                    "le": clean_for_json(le_tel),
                    "math": clean_for_json(math_tel),
                    # expr will be added after loop
                }
            
                # Add to batch
                frames_this_cycle.append(frame)
                
                sample_time = (time.perf_counter() - sample_start) * 1000
                if sample_time > 50:  # Only log slow samples
                    print(f"[SAMPLE-TIMING] Sample {sample_idx+1}/{samples_to_grab} took {sample_time:.1f}ms")

                ticks += 1
                log_ctr += 1

                # --- Logging: at full acq rate (or LOG_EVERY) ---
                if log_ctr >= LOG_EVERY and session_logger is not None:
                    session_logger.write(frame)
                    log_ctr = 0
            
            # End of single sample processing loop

            # --- Expressions (using PRE-COMPILED AST cache) ---
            # --- Expressions ---
            t_expr_start = time.perf_counter()
            # Evaluate expressions after everything else so they can see all signal states
            try:
                tc_count = len(get_all_thermocouples(app_cfg)) if get_all_thermocouples(app_cfg) else 0
                # Use PRE-COMPILED expressions (100x faster!)
                batch_expr_tel = evaluate_compiled_expressions({
                    "ai": ai_scaled,
                    "ao": ao,
                    "do": do,
                    "tc": tc_vals,
                    "pid": telemetry,
                    "math": math_tel,
                    "le": le_tel,
                    "expr": last_expr_outputs,  # Previous cycle expressions (avoid circular dependency)
                    "buttonVars": button_vars,  # Button variables from frontend
                    "ai_list": [{"name": ch.name} for ch in get_all_analogs(app_cfg)] + [{"name": "△ Triangle (1s)"}],  # Add synthetic signal
                    "ao_list": [{"name": ch.name} for ch in get_all_analog_outputs(app_cfg)],
                    "tc_list": [{"name": ch.name} for ch in get_all_thermocouples(app_cfg)],
                    "do_list": [{"name": ch.name} for ch in get_all_digital_outputs(app_cfg)],
                    "pid_list": [{"name": loop.name} for loop in pid_mgr.meta],
                    "math_list": [{"name": op.name} for op in math_mgr.operators],
                    "le_list": [{"name": elem.name} for elem in le_mgr.elements],
                    "expr_list": [{"name": expr.name} for expr in expr_mgr.expressions]
                }, bridge=mcc, sample_rate_hz=TARGET_UI_HZ)  # Pass actual eval rate, not acq rate!
            
                # Extract expr outputs for use in PID gates and other systems
                expr_outputs = [e.get("output", 0.0) for e in batch_expr_tel]
            
                # Store for next cycle (PIDs will use these as gates/inputs)
                last_expr_outputs = expr_outputs
            except Exception as e:
                print(f"[EXPR] Evaluation error: {e}")
                import traceback
                traceback.print_exc()
                # Keep previous values on error
                expr_outputs = last_expr_outputs if last_expr_outputs else [0.0] * len(expr_mgr.expressions)
            
            t_expr_time = (time.perf_counter() - t_expr_start) * 1000
            if t_expr_time > 10:
                executed_count = sum(1 for e in batch_expr_tel if not e.get('skipped', False))
                print(f"[EXPR-TIMING] {executed_count}/{len(batch_expr_tel)} expressions executed in {t_expr_time:.1f}ms ({t_expr_time/max(1,executed_count):.1f}ms per expr)")
            
            # Debug expression telemetry format
            display_cycle = ticks // 10  # Approximate display cycles (varies by samples processed)
            if display_cycle == 1 and ticks < 20:  # Trigger once early
                print(f"[EXPR-DEBUG] Tick {ticks}: Sending {len(batch_expr_tel)} expression telemetry items")
                if batch_expr_tel:
                    print(f"[EXPR-DEBUG] Sample telemetry: {batch_expr_tel[0]}")
                if frames_this_cycle:
                    expr_field = frames_this_cycle[0].get('expr')
                    if expr_field:
                        print(f"[EXPR-DEBUG] Frame has {len(expr_field)} expr items")
                    else:
                        print(f"[EXPR-DEBUG] Frame expr field: {expr_field}")



            # Add expression telemetry to all frames (now that it's populated)
            if ticks < 20:
                print(f"[EXPR-DEBUG] Before adding expr: frames={len(frames_this_cycle)}, batch_expr_tel={len(batch_expr_tel)} items")
            
            for frame in frames_this_cycle:
                frame["expr"] = clean_for_json(batch_expr_tel)
            
            if ticks < 20 and frames_this_cycle:
                print(f"[EXPR-DEBUG] After adding expr: frame['expr'] has {len(frames_this_cycle[0].get('expr', []))} items")
            
            # --- Send batch after processing all samples ---
            if frames_this_cycle:
                # ROLL MODE: Send batch to frontend for charts
                batch_msg = {
                    "type": "batch",
                    "samples": frames_this_cycle,
                    "count": len(frames_this_cycle),
                    "acq_rate": acq_rate_hz,  # Processing rate (roll mode)
                    "hw_sample_rate": hw_sample_rate_hz  # Hardware sampling rate (scope mode)
                }
                asyncio.create_task(broadcast(batch_msg))  # Fire and forget!
                
                # SCOPE MODE: Feed to scope processor for trigger detection
                if scope_processor and scope_processor.trigger_state.enabled:
                    scope_processor.process_samples(frames_this_cycle, hw_sample_rate_hz)
                
                # Log processing stats
                if len(frames_this_cycle) >= 100 or ticks % 50 == 0:
                    with buffer_lock:
                        buf_size = len(sample_buffer)
                    cycle_time = (time.perf_counter() - display_start) * 1000
                    print(f"[PROCESS] Processed {len(frames_this_cycle)} samples in {cycle_time:.1f}ms | Buffer: {buf_size}")

            # Debug for first few ticks (moved inside sample loop above)
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

    except Exception as e:
        print(f"[MCC-Hub] ACQUISITION LOOP ERROR: {e}")
        import traceback
        traceback.print_exc()
    finally:
        # Stop acquisition thread
        print("[MCC-Hub] Stopping acquisition thread...")
        burst_running.clear()
        if acquisition_thread and acquisition_thread.is_alive():
            acquisition_thread.join(timeout=2.0)
        print("[MCC-Hub] Acquisition loop stopping")



@app.get("/api/config")
def get_config():
    # read latest from disk so external edits are visible
    cfg = _load_json_model(CFG_PATH, AppConfig)
    cfg_dict = cfg.model_dump()
    
    # Add synthetic test signal to AI list for frontend display
    # Find which board to add it to (use first enabled board, or create a virtual one)
    if cfg_dict.get('boards1608') and len(cfg_dict['boards1608']) > 0:
        # Add to last board's analog list
        last_board = cfg_dict['boards1608'][-1]
        if 'analogs' not in last_board:
            last_board['analogs'] = []
        # Add synthetic signal
        last_board['analogs'].append({
            'name': 'Test',
            'enabled': True,
            'cutoffHz': 0,
            'slope': 1.0,
            'offset': 0.0
        })
    
    return cfg_dict

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

@app.get("/api/math_operators")
def get_math_operators():
    return _load_json_model(MATH_PATH, MathOpFile).model_dump()

@app.put("/api/math_operators")
def put_math_operators(body: dict):
    global math_mgr
    math_file = MathOpFile.model_validate(body)
    MATH_PATH.write_text(json.dumps(math_file.model_dump(), indent=2))
    load_math()
    return {"ok": True}

@app.get("/api/expressions")
def get_expressions():
    """Get all expressions"""
    return expr_mgr.to_dict()

@app.put("/api/expressions")
def put_expressions(body: dict):
    """Save expressions"""
    try:
        expr_mgr.from_dict(body)
        return {"ok": True}
    except Exception as e:
        return {"ok": False, "error": str(e)}

@app.post("/api/expressions/reload")
def reload_expressions():
    """Hot-reload expressions from config without restarting server"""
    global expr_ast_cache, expr_mgr, app_cfg
    try:
        # Re-read config
        cfg_path = Path(__file__).parent / "config.json"
        with open(cfg_path) as f:
            new_cfg = json.load(f)
        
        # Update global config
        app_cfg = AppConfig(**new_cfg)
        
        # Update expression manager
        from expr_mgr import ExpressionManager
        expr_mgr = ExpressionManager()
        expr_mgr.expressions = app_cfg.expressions
        
        # Re-compile all expressions using same logic as startup
        from expr_engine import Lexer, Parser
        expr_ast_cache.clear()
        compiled_count = 0
        
        for i, expr in enumerate(expr_mgr.expressions):
            try:
                lexer = Lexer(expr.expression)
                tokens = lexer.tokenize()
                parser = Parser(tokens)
                ast = parser.parse()
                expr_ast_cache[i] = ast
                log.info(f"[EXPR-RELOAD] Pre-compiled: {expr.name}")
                compiled_count += 1
            except Exception as e:
                log.error(f"[EXPR-RELOAD] Failed to pre-compile '{expr.name}': {e}")
                expr_ast_cache[i] = None
        
        print(f"[EXPR-RELOAD] ✅ Reloaded {compiled_count}/{len(expr_mgr.expressions)} expressions")
        return {"ok": True, "count": compiled_count}
    except Exception as e:
        print(f"[EXPR-RELOAD] ❌ Error: {e}")
        import traceback
        traceback.print_exc()
        return {"ok": False, "error": str(e)}

@app.post("/api/expressions/check")
def check_expression_syntax(body: dict):
    """Check expression syntax"""
    expression = body.get('expression', '')
    
    # Build test signal state with current config
    test_state = {
        'ai_list': [{'name': ch.name} for ch in get_all_analogs(app_cfg)] + [{'name': '△ Triangle (1s)'}],
        'ai': [0.0] * len(get_all_analogs(app_cfg)) + [0.5],  # Add synthetic value
        'ao_list': [{'name': ch.name} for ch in (get_all_analog_outputs(app_cfg) or [])],
        'ao': [0.0] * len(get_all_analog_outputs(app_cfg) or []),
        'tc_list': [{'name': tc.name} for tc in (get_all_thermocouples(app_cfg) or [])],
        'tc': [0.0] * len(get_all_thermocouples(app_cfg) or []),
        'do_list': [{'name': ch.name} for ch in (get_all_digital_outputs(app_cfg) or [])],
        'do': [0] * len(get_all_digital_outputs(app_cfg) or []),
        'pid_list': [{'name': loop.name} for loop in (pid_mgr.meta if pid_mgr else [])],
        'pid': [{'out': 0, 'u': 0, 'pv': 0, 'target': 0, 'err': 0}] * len(pid_mgr.meta if pid_mgr else []),
        'math_list': [{'name': op.name} for op in math_mgr.operators],
        'math': [0.0] * len(math_mgr.operators),
        'le_list': [{'name': elem.name} for elem in le_mgr.elements],
        'le': [0] * len(le_mgr.elements),
        'expr_list': [{'name': expr.name} for expr in expr_mgr.expressions],
        'expr': [0.0] * len(expr_mgr.expressions),
        'time': 0.0,
        'sample': 0
    }
    
    return expr_mgr.check_syntax(expression, test_state)

@app.get("/api/expressions/globals")
def get_expression_globals():
    """Get all global variables"""
    return {"globals": expr_global_vars.list_all()}

@app.delete("/api/expressions/globals")
def delete_expression_global(body: dict):
    """Delete a specific global variable"""
    name = body.get('name')
    if name and name in expr_global_vars._vars:
        del expr_global_vars._vars[name]
        return {"ok": True}
    return {"ok": False, "error": "Variable not found"}

@app.post("/api/expressions/globals/clear")
def clear_expression_globals():
    """Clear all global variables"""
    expr_global_vars.clear()
    return {"ok": True}

@app.post("/api/button_vars")
def update_button_vars(body: dict):
    """Update button variable states from frontend"""
    global button_vars
    vars_dict = body.get('vars', {})
    button_vars.update(vars_dict)
    return {"ok": True}

@app.get("/api/button_vars")
def get_button_vars():
    """Get current button variable states"""
    return {"vars": button_vars}

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
    global acq_rate_hz, _need_reconfig_filters, app_cfg
    acq_rate_hz = max(1.0, float(req.hz))
    _need_reconfig_filters = True

    # Save rate to config for all enabled boards
    if app_cfg.boards1608:
        for board in app_cfg.boards1608:
            if board.enabled:
                board.sampleRateHz = acq_rate_hz
        
        # Save config to disk
        try:
            CFG_PATH.write_text(json.dumps(app_cfg.model_dump(), indent=2))
            print(f"[MCC-Hub] Rate set to {acq_rate_hz} Hz and saved to config")
        except Exception as e:
            print(f"[MCC-Hub] Rate set to {acq_rate_hz} Hz but failed to save: {e}")
    else:
        print(f"[MCC-Hub] Rate set to {acq_rate_hz} Hz (not saved - no boards)")

    return {"ok": True, "rate": acq_rate_hz}

@app.post("/api/acq/hw_rate")
def set_hw_rate(req: RateReq):
    global hw_sample_rate_hz
    requested_rate = max(1.0, min(500000.0, float(req.hz)))
    
    # E-1608 spec: 250 kS/s maximum
    if requested_rate > 250000:
        print(f"[MCC-Hub] WARNING: HW rate {requested_rate} Hz exceeds E-1608 spec (250 kHz)")
        print(f"[MCC-Hub] Hardware will run at maximum achievable rate")
    
    hw_sample_rate_hz = requested_rate
    print(f"[MCC-Hub] Hardware sample rate set to {hw_sample_rate_hz} Hz")
    return {"ok": True, "rate": hw_sample_rate_hz}

@app.post("/api/scope/trigger")
def set_scope_trigger(data: dict):
    """Configure scope trigger settings"""
    global scope_processor
    
    if scope_processor is None:
        return {"ok": False, "error": "Scope processor not initialized"}
    
    # Update scope processor configuration
    scope_processor.configure_trigger(**data, hw_sample_rate=hw_sample_rate_hz)
    
    print(f"[SCOPE] Trigger configured via API: mode={data.get('mode')}, "
          f"level={data.get('level')}, edge={data.get('edge')}")
    
    return {"ok": True, "state": {
        'mode': scope_processor.trigger_state.mode,
        'level': scope_processor.trigger_state.level,
        'edge': scope_processor.trigger_state.edge,
        'position': scope_processor.trigger_state.position,
        'armed': scope_processor.trigger_state.armed
    }}

@app.post("/api/display/rate")
def set_display_rate(req: RateReq):
    global TARGET_UI_HZ, app_cfg
    TARGET_UI_HZ = max(1.0, min(500.0, float(req.hz)))
    
    # Save to config
    app_cfg.display_rate_hz = TARGET_UI_HZ
    try:
        CFG_PATH.write_text(json.dumps(app_cfg.model_dump(), indent=2))
        print(f"[MCC-Hub] Display rate set to {TARGET_UI_HZ} Hz and saved to config")
    except Exception as e:
        print(f"[MCC-Hub] Display rate set to {TARGET_UI_HZ} Hz but failed to save: {e}")
    
    return {"ok": True, "rate": TARGET_UI_HZ}

@app.get("/api/rates")
def get_rates():
    """Get current acquisition and display rates"""
    return {
        "acq_rate": acq_rate_hz,
        "hw_sample_rate": hw_sample_rate_hz,
        "display_rate": TARGET_UI_HZ
    }

# Old rate endpoint continues below...

    # Reconfigure the E-1608 AI block scan to match the new acquisition rate.
    # This keeps the hardware sampling in sync with the logical acq_rate_hz,
    # while still using block-based reads under the hood for performance.
    try:
        # Get blockSize from first enabled E-1608 board
        blockSize = 128  # Default
        if app_cfg.boards1608:
            for board in app_cfg.boards1608:
                if board.enabled:
                    blockSize = board.blockSize
                    break
        # Note: configure_ai_scan not needed for individual channel reads
    except Exception as e:
        print(f"[MCC-Hub] AI scan reconfig warn: {e}")

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
        if cfg is not None:
            all_dos = get_all_digital_outputs(cfg)
            if idx < len(all_dos):
                do_cfg = all_dos[idx]
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

class BuzzStart(BaseModel):
    index: int
    hz: float
    active_high: bool = True

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
    ao_cfg = get_all_analog_outputs(app_cfg)[req.index] if req.index < len(get_all_analog_outputs(app_cfg)) else None
    
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
    """Zero/balance AI channels by averaging and adjusting offsets"""
    channels = req.get("channels", [])
    averaging_period = req.get("averaging_period", 1.0)
    balance_to_value = req.get("balance_to_value", 0.0)
    
    if not channels:
        return {"ok": False, "error": "No channels specified"}
    
    # Validate channels
    for ch in channels:
        if ch < 0 or ch >= len(get_all_analogs(app_cfg)):
            return {"ok": False, "error": f"Invalid channel index: {ch}"}
    
    # Collect samples at 100Hz for averaging_period
    sample_rate = 100.0  # Hz
    num_samples = int(averaging_period * sample_rate)
    samples = {ch: [] for ch in channels}
    
    print(f"[Zero AI] Collecting {num_samples} samples for channels {channels}...")
    
    for _ in range(num_samples):
        ai_raw = mcc.read_ai_all()
        
        for ch in channels:
            if ch < len(ai_raw):
                # Apply current slope and offset to get scaled value
                cfg = get_all_analogs(app_cfg)[ch]
                scaled = cfg.slope * ai_raw[ch] + cfg.offset
                samples[ch].append(scaled)
        
        await asyncio.sleep(1.0 / sample_rate)
    
    # Calculate averages and update offsets in actual board structure
    offsets_list = []
    for ch in channels:
        if not samples[ch]:
            return {"ok": False, "error": f"No valid samples for channel {ch}"}
        
        avg = sum(samples[ch]) / len(samples[ch])
        
        # Find which board and channel this global index maps to
        global_idx = ch
        found = False
        for board in app_cfg.boards1608:
            if not board.enabled:
                continue
            if global_idx < len(board.analogs):
                # Found it! Update offset in the actual board structure
                old_offset = board.analogs[global_idx].offset
                new_offset = old_offset - (avg - balance_to_value)
                board.analogs[global_idx].offset = new_offset
                
                offsets_list.append({
                    "channel": ch,
                    "old": old_offset,
                    "new": new_offset,
                    "avg": avg
                })
                print(f"[Zero AI] CH{ch} (board #{board.boardNum}, ch{global_idx}): avg={avg:.6f}, old_offset={old_offset:.6f}, new_offset={new_offset:.6f}")
                found = True
                break
            else:
                global_idx -= len(board.analogs)
        
        if not found:
            print(f"[Zero AI] WARNING: Could not find board for channel {ch}")
    
    # Debug: Check if changes are in the model
    print(f"[Zero AI] Before save - checking offsets in app_cfg:")
    for ch in channels:
        global_idx = ch
        for board in app_cfg.boards1608:
            if not board.enabled:
                continue
            if global_idx < len(board.analogs):
                print(f"  CH{ch} -> board #{board.boardNum}, analog[{global_idx}].offset = {board.analogs[global_idx].offset}")
                break
            else:
                global_idx -= len(board.analogs)
    
    # Save config
    config_dict = app_cfg.model_dump()
    CFG_PATH.write_text(json.dumps(config_dict, indent=2))
    print(f"[Zero AI] Config saved to {CFG_PATH}")
    
    # Verify save
    saved_text = CFG_PATH.read_text()
    print(f"[Zero AI] Saved config size: {len(saved_text)} bytes")
    
    return {"ok": True, "offsets": offsets_list}

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
