# server/pid_core.py
from dataclasses import dataclass
from typing import List, Dict, Optional

@dataclass
class LoopDef:
    enabled: bool
    kind: str           # "analog" | "digital" | "var"
    src: str            # "ai" | "tc"
    ai_ch: int
    out_ch: int         # AO idx for analog, DO idx for digital
    target: float
    kp: float
    ki: float
    kd: float
    out_min: Optional[float] = None
    out_max: Optional[float] = None
    err_min: Optional[float] = None
    err_max: Optional[float] = None
    i_min: Optional[float] = None
    i_max: Optional[float] = None
    name: str = ""
    enable_gate: bool = False      # Whether to gate this PID with a DO/LE
    enable_kind: str = "do"        # 'do' or 'le'
    enable_index: int = 0          # Which DO/LE to use as enable

class _PID:
    def __init__(self, d: LoopDef):
        self.d = d
        self.i = 0.0
        self.prev = None

    def step(self, pv: float, dt: float):
        e = self.d.target - pv
        if self.d.err_min is not None: e = max(self.d.err_min, e)
        if self.d.err_max is not None: e = min(self.d.err_max, e)
        p = self.d.kp * e
        self.i += self.d.ki * e * dt
        if self.d.i_min is not None: self.i = max(self.d.i_min, self.i)
        if self.d.i_max is not None: self.i = min(self.d.i_max, self.i)
        d = 0.0
        if self.prev is not None:
            d = self.d.kd * (e - self.prev) / max(1e-6, dt)
        self.prev = e
        u = p + self.i + d
        return u, e, p, self.i, d  # Return u, error, p_term, i_term, d_term

class PIDManager:
    def __init__(self):
        self.loops: List[_PID] = []
        self.meta: List[LoopDef] = []
        self.last_gate_states: List[bool] = []  # Track gate states for change detection

    def load(self, pid_file):
        # Preserve existing PID states when reloading config
        # Only reset state on disable/gate, never on parameter changes
        old_loops = {meta.name: (pid, meta) for pid, meta in zip(self.loops, self.meta)}
        
        new_loops = []
        new_meta = []
        new_gate_states = []
        
        for rec in pid_file.loops:
            d = LoopDef(**rec.dict())
            
            # Check if this PID existed before with same name
            if d.name in old_loops:
                old_pid, old_meta = old_loops[d.name]
                
                # Update parameters, keep ALL state intact (i, prev)
                old_pid.d = d
                
                new_loops.append(old_pid)
            else:
                # New PID - create fresh
                new_loops.append(_PID(d))
            
            new_meta.append(d)
            new_gate_states.append(True)  # Assume enabled initially
        
        # Atomic swap - replace all lists at once
        self.loops = new_loops
        self.meta = new_meta
        self.last_gate_states = new_gate_states

    def step(self, ai_vals: List[float], tc_vals: List[float], bridge, do_state=None, le_state=None, pid_prev=None, math_outputs=None) -> List[Dict]:
        import time
        dt = 1.0  # approximate; the outer loop is rate-controlled
        tel = []
        for i, (p, d) in enumerate(zip(self.loops, self.meta)):
            if not d.enabled:
                # PID disabled via checkbox - reset state and force outputs to safe state
                p.i = 0.0
                p.prev = None
                
                # Force outputs to safe state based on kind
                if d.kind == "digital":
                    bridge.set_do(d.out_ch, False, active_high=True)  # Force to 0
                elif d.kind == "analog":
                    # Force to minimum (typically 0V)
                    min_val = -10.0 if d.out_min is None else d.out_min
                    bridge.set_ao(d.out_ch, min_val)
                # var kind doesn't write to hardware
                
                # Add placeholder telemetry for disabled loops to maintain indexing
                tel.append({"name": d.name, "pv": 0.0, "u": 0.0, "out": 0.0, "err": 0.0, "enabled": False})
                continue
                
            # Check enable gate if configured
            gate_enabled = True
            if d.enable_gate:
                if d.enable_kind == "do" and do_state is not None:
                    if d.enable_index < len(do_state):
                        gate_enabled = bool(do_state[d.enable_index])
                    else:
                        gate_enabled = False
                elif d.enable_kind == "le" and le_state is not None:
                    if d.enable_index < len(le_state):
                        gate_enabled = le_state[d.enable_index].get("output", False)
                    else:
                        gate_enabled = False
                
                # Log and handle state transitions
                if i < len(self.last_gate_states):
                    if gate_enabled != self.last_gate_states[i]:
                        gate_type = f"{d.enable_kind.upper()}{d.enable_index}"
                        state_str = "ENABLED" if gate_enabled else "DISABLED"
                        print(f"[PID-GATE] Loop '{d.name}': {gate_type} → {state_str}")
                        
                        # Reset PID state when transitioning to disabled
                        if not gate_enabled:
                            p.i = 0.0
                            p.prev = None
                            print(f"[PID-GATE] Loop '{d.name}': State reset (i=0, prev=None)")
                            
                            # Force outputs to safe state
                            if d.kind == "digital":
                                bridge.set_do(d.out_ch, False, active_high=True)
                            elif d.kind == "analog":
                                bridge.set_ao(d.out_ch, 0.0)
                        
                        self.last_gate_states[i] = gate_enabled
            
            # If gated, don't calculate - return zeros immediately
            if not gate_enabled:
                tel.append({"name": d.name, "pv": 0.0, "u": 0.0, "out": 0.0, "err": 0.0, "enabled": True, "gated": True})
                continue
            
            # Gate enabled - calculate PID normally
            try:
                pv = 0.0
                if d.src == "ai":
                    pv = ai_vals[d.ai_ch]
                elif d.src == "ao":
                    # Read AO value (feedback from analog output)
                    if d.ai_ch < len(bridge.ao_cache):
                        pv = bridge.ao_cache[d.ai_ch]
                elif d.src == "tc" and tc_vals:
                    pv = tc_vals[min(d.ai_ch, len(tc_vals)-1)]
                elif d.src == "pid" and pid_prev:
                    # Use previous cycle's PID output (cascade control)
                    if d.ai_ch < len(pid_prev):
                        pv = pid_prev[d.ai_ch].get("out", 0.0)
                elif d.src == "math" and math_outputs:
                    # Use math operator output
                    if d.ai_ch < len(math_outputs):
                        pv = math_outputs[d.ai_ch]
                u, err, p_term, i_term, d_term = p.step(pv, dt)
                
                # Calculate output value
                if d.kind == "digital":
                    ov = 1.0 if u >= 0 else 0.0
                elif d.kind == "var":
                    ov = u
                else:  # analog
                    lo = -10.0 if d.out_min is None else d.out_min
                    hi =  10.0 if d.out_max is None else d.out_max
                    ov = max(lo, min(hi, u))
                
                # Write to hardware (we only get here if gate_enabled or no gate)
                if d.kind == "digital":
                    bridge.set_do(d.out_ch, u >= 0.0, active_high=True)
                elif d.kind == "analog":
                    bridge.set_ao(d.out_ch, ov)
                # var kind never writes to hardware
                
                tel.append({
                    "name": d.name, 
                    "pv": pv, 
                    "u": u, 
                    "out": ov, 
                    "err": err, 
                    "p_term": p_term,
                    "i_term": i_term,
                    "d_term": d_term,
                    "target": d.target,
                    "enabled": True, 
                    "gated": False
                })
            except Exception as e:
                # Log error but continue with other PIDs
                print(f"[PID] Loop '{d.name}' (kind={d.kind}) failed: {e}")
                tel.append({"name": d.name, "pv": 0.0, "u": 0.0, "out": 0.0, "err": 0.0, "error": str(e), "enabled": True})
        return tel