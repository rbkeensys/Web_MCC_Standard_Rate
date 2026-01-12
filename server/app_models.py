# server/app_models.py
from pydantic import BaseModel
from typing import List, Optional

class Board1608Cfg(BaseModel):
    boardNum: int = 0
    sampleRateHz: float = 100.0
    blockSize: int = 128
    aiMode: str = "SE"

class BoardEtcCfg(BaseModel):
    boardNum: int = 1
    sampleRateHz: float = 10.0
    blockSize: int = 1

class AnalogCfg(BaseModel):
    name: str = "AI"
    slope: float = 1.0
    offset: float = 0.0
    cutoffHz: float = 0.0
    units: str = ""
    include: bool = True

class DigitalOutCfg(BaseModel):
    name: str = "DO"
    normallyOpen: bool = True
    momentary: bool = False
    actuationTime: float = 0.0
    include: bool = True
    logicElement: Optional[int] = None  # NEW: Index of LE that gates this DO (None = no gating)

class AnalogOutCfg(BaseModel):
    name: str = "AO"
    minV: float = 0.0
    maxV: float = 10.0
    startupV: float = 0.0
    include: bool = True
    enable_gate: bool = False  # Whether to gate this AO with a DO/LE
    enable_kind: str = "do"    # 'do' or 'le'
    enable_index: int = 0      # Which DO/LE to use as enable

class ThermocoupleCfg(BaseModel):
    include: bool = True
    ch: int = 0
    name: str = "TC"
    type: str = "K"
    offset: float = 0.0
    cutoffHz: float = 0.0  # Low-pass filter cutoff frequency (0 = disabled)

class AppConfig(BaseModel):
    board1608: Board1608Cfg
    boardetc: BoardEtcCfg
    analogs: List[AnalogCfg]
    digitalOutputs: List[DigitalOutCfg]
    analogOutputs: List[AnalogOutCfg]
    thermocouples: List[ThermocoupleCfg]

class PIDRec(BaseModel):
    enabled: bool = False
    kind: str = "analog"
    src: str = "ai"
    ai_ch: int = 0
    out_ch: int = 0
    target: float = 0.0
    kp: float = 0.0
    ki: float = 0.0
    kd: float = 0.0
    out_min: Optional[float] = None
    out_max: Optional[float] = None
    err_min: Optional[float] = None
    err_max: Optional[float] = None
    i_min: Optional[float] = None
    i_max: Optional[float] = None
    name: str = ""
    enable_gate: bool = False
    enable_kind: str = "do"
    enable_index: int = 0
    execution_rate_hz: Optional[float] = None  # None = run at sample rate

class PIDFile(BaseModel):
    loops: List[PIDRec] = []

class ScriptFile(BaseModel):
    events: List[dict] = []

class MotorControllerCfg(BaseModel):
    name: str = "Motor"
    port: str = "COM1"
    baudrate: int = 9600
    address: int = 1
    min_rpm: float = 0.0
    max_rpm: float = 2500.0
    input_source: str = "ai"  # "ai" or "ao"
    input_channel: int = 0
    input_min: float = 0.0
    input_max: float = 10.0
    scale_factor: float = 250.0  # default: 0-10 -> 0-2500 RPM
    offset: float = 0.0
    cw_positive: bool = True
    enabled: bool = False
    include: bool = True
    logicElement: Optional[int] = None  # NEW: Index of LE that enables this motor (None = no gating)

class MotorFile(BaseModel):
    motors: List[MotorControllerCfg] = []

# NEW: Logic Element models
class LEInputCfg(BaseModel):
    kind: str = "do"  # "do", "ai", "ao", "tc", "pid_u", "le"
    index: int = 0
    # For analog values:
    comparison: Optional[str] = None  # "lt", "eq", "gt"
    compare_to_type: Optional[str] = None  # "value" or "signal"
    compare_value: Optional[float] = None
    compare_to_kind: Optional[str] = None  # "ai", "ao", "tc", "pid_u"
    compare_to_index: Optional[int] = None

class LogicElementCfg(BaseModel):
    enabled: bool = True
    name: str = "LE"
    input_a: LEInputCfg
    input_b: LEInputCfg
    operation: str = "and"  # "and", "or", "xor", "nand", "nor", "nxor"

class LEFile(BaseModel):
    elements: List[LogicElementCfg] = []

# sensible defaults mirroring your previous app
def default_config():
    return {
        "board1608": {"boardNum": 0, "sampleRateHz": 100.0, "blockSize": 128, "aiMode": "SE"},
        "boardetc":  {"boardNum": 1, "sampleRateHz": 10.0,  "blockSize": 1},
        "analogs":   [{"name": f"AI{i}", "slope": 1.0, "offset": 0.0, "cutoffHz": 0.0, "units": "", "include": True} for i in range(8)],
        "digitalOutputs": [{"name": f"DO{i}", "normallyOpen": True, "momentary": False, "actuationTime": 0.0, "include": True, "logicElement": None} for i in range(8)],
        "analogOutputs":  [{"name": f"AO{i}", "minV":0, "maxV":10, "startupV":0, "include": True} for i in range(2)],
        "thermocouples":  [{"include": True, "ch": i, "name": f"TC{i}", "type": "K", "offset": 0.0} for i in range(8)],
    }
