# server/math_ops.py
"""
Mathematical operator system for signal processing.
Provides unary and binary math operations on analog signals.
"""

from typing import List, Dict, Optional
from pydantic import BaseModel
import math

class MathOpInput(BaseModel):
    """Input source for a math operator"""
    kind: str = "ai"  # ai, ao, tc, pid_u, math, value
    index: int = 0
    value: Optional[float] = None  # For kind='value', use this fixed value

class MathOperator(BaseModel):
    """Single math operator definition"""
    enabled: bool = True
    name: str = ""
    operation: str = "add"  # Unary: sqr, sqrt, log10, ln, exp, sin, cos, tan, abs, neg, filter
                            # Binary: add, sub, mul, div, mod, pow, min, max
                            # Conditional: if_gt, if_gte, if_lt, if_lte, if_eq, if_neq
    input_a: MathOpInput = MathOpInput()
    input_b: Optional[MathOpInput] = None  # For binary and conditional operations
    # For IF operations:
    output_true: Optional[MathOpInput] = None   # Value when condition is true
    output_false: Optional[MathOpInput] = None  # Value when condition is false
    filter_hz: Optional[float] = None  # Cutoff frequency for 'filter' operation (Hz)
    # For output to hardware:
    has_output: bool = False              # True if this operator writes to AO/DO
    output_type: Optional[str] = None     # 'ao' or 'do'
    output_channel: Optional[int] = None  # Which AO/DO channel
    output_min: Optional[float] = None    # Min clamp for AO
    output_max: Optional[float] = None    # Max clamp for AO

class MathOpFile(BaseModel):
    """Configuration file for math operators"""
    operators: List[MathOperator] = []

class MathOpManager:
    """Manages evaluation of math operators"""
    
    # Define which operations are unary vs binary vs conditional
    UNARY_OPS = {'sqr', 'sqrt', 'log10', 'ln', 'exp', 'sin', 'cos', 'tan', 'abs', 'neg', 'asin', 'acos', 'atan', 'filter'}
    BINARY_OPS = {'add', 'sub', 'mul', 'div', 'mod', 'pow', 'min', 'max', 'atan2'}
    IF_OPS = {'if_gt', 'if_gte', 'if_lt', 'if_lte', 'if_eq', 'if_neq'}
    
    def __init__(self):
        self.operators: List[MathOperator] = []
        self.outputs: List[float] = []
        self.filter_states: List[Dict] = []  # Store filter state per operator
        self.last_time: Optional[float] = None
    
    def load(self, math_file: MathOpFile):
        """Load operators from config"""
        self.operators = math_file.operators
        self.outputs = [0.0] * len(self.operators)
        self.filter_states = [{'value': 0.0, 'raw': 0.0} for _ in self.operators]
        self.last_time = None
        print(f"[MathOps] Loaded {len(self.operators)} math operators")
    
    def get_input_value(self, inp: MathOpInput, state: Dict) -> float:
        """Get value from an input source"""
        try:
            if inp.kind == "ai":
                vals = state.get("ai", [])
                if inp.index < len(vals):
                    v = vals[inp.index]
                    return v if math.isfinite(v) else 0.0
                return 0.0
            
            elif inp.kind == "ao":
                vals = state.get("ao", [])
                if inp.index < len(vals):
                    v = vals[inp.index]
                    return v if math.isfinite(v) else 0.0
                return 0.0
            
            elif inp.kind == "tc":
                vals = state.get("tc", [])
                if inp.index < len(vals):
                    v = vals[inp.index]
                    return v if v is not None and math.isfinite(v) else 0.0
                return 0.0
            
            elif inp.kind == "pid_u":
                pid_vals = state.get("pid", [])
                if inp.index < len(pid_vals):
                    return pid_vals[inp.index].get("u", 0.0)
                return 0.0
            
            elif inp.kind == "math":
                # Reference to another math operator output
                if inp.index < len(self.outputs):
                    return self.outputs[inp.index]
                return 0.0
            
            elif inp.kind == "value":
                # Use fixed value
                return inp.value if inp.value is not None else 0.0
            
            return 0.0
        except Exception as e:
            print(f"[MathOps] Error getting input value: {e}")
            return 0.0
    
    def evaluate_all(self, state: Dict, bridge=None) -> List[Dict]:
        """Evaluate all enabled operators and return telemetry"""
        telemetry = []
        
        for i, op in enumerate(self.operators):
            if not op.enabled:
                self.outputs[i] = 0.0
                telemetry.append({
                    "name": op.name or f"Math{i}",
                    "operation": op.operation,
                    "input_a": 0.0,
                    "input_b": None,
                    "output": 0.0,
                    "enabled": False
                })
                continue
            
            try:
                # Get input(s)
                val_a = self.get_input_value(op.input_a, state)
                val_b = None
                
                # Perform operation
                result = 0.0
                
                # Unary operations
                if op.operation == "sqr":
                    result = val_a * val_a
                elif op.operation == "sqrt":
                    result = math.sqrt(abs(val_a))  # abs to avoid NaN
                elif op.operation == "log10":
                    result = math.log10(abs(val_a)) if val_a != 0 else 0.0
                elif op.operation == "ln":
                    result = math.log(abs(val_a)) if val_a != 0 else 0.0
                elif op.operation == "exp":
                    result = math.exp(min(val_a, 100))  # Clamp to prevent overflow
                elif op.operation == "sin":
                    result = math.sin(val_a)
                elif op.operation == "cos":
                    result = math.cos(val_a)
                elif op.operation == "tan":
                    result = math.tan(val_a)
                elif op.operation == "asin":
                    result = math.asin(max(-1, min(1, val_a)))  # Clamp to [-1, 1]
                elif op.operation == "acos":
                    result = math.acos(max(-1, min(1, val_a)))
                elif op.operation == "atan":
                    result = math.atan(val_a)
                elif op.operation == "abs":
                    result = abs(val_a)
                elif op.operation == "neg":
                    result = -val_a
                elif op.operation == "filter":
                    # First-order low-pass filter: y[n] = y[n-1] + alpha * (x[n] - y[n-1])
                    # where alpha = dt / (RC + dt) and RC = 1/(2*pi*fc)
                    cutoff_hz = op.filter_hz if op.filter_hz and op.filter_hz > 0 else 1.0
                    
                    # Calculate dt
                    import time
                    current_time = time.time()
                    if self.last_time is None:
                        dt = 0.01  # Default 10ms
                    else:
                        dt = max(1e-6, current_time - self.last_time)
                    
                    # Calculate alpha
                    RC = 1.0 / (2.0 * math.pi * cutoff_hz)
                    alpha = dt / (RC + dt)
                    
                    # Get previous filtered value
                    prev_value = self.filter_states[i]['value']
                    
                    # Apply filter
                    result = prev_value + alpha * (val_a - prev_value)
                    
                    # Store raw and filtered values
                    self.filter_states[i]['raw'] = val_a
                    self.filter_states[i]['value'] = result
                
                # Binary operations
                elif op.operation in self.BINARY_OPS:
                    if op.input_b is None:
                        result = 0.0
                    else:
                        val_b = self.get_input_value(op.input_b, state)
                        
                        if op.operation == "add":
                            result = val_a + val_b
                        elif op.operation == "sub":
                            result = val_a - val_b
                        elif op.operation == "mul":
                            result = val_a * val_b
                        elif op.operation == "div":
                            result = val_a / val_b if val_b != 0 else 0.0
                        elif op.operation == "mod":
                            result = val_a % val_b if val_b != 0 else 0.0
                        elif op.operation == "pow":
                            result = math.pow(val_a, val_b)
                        elif op.operation == "min":
                            result = min(val_a, val_b)
                        elif op.operation == "max":
                            result = max(val_a, val_b)
                        elif op.operation == "atan2":
                            result = math.atan2(val_a, val_b)
                
                # Conditional (IF) operations
                elif op.operation in self.IF_OPS:
                    if op.input_b is None or op.output_true is None or op.output_false is None:
                        result = 0.0
                    else:
                        val_b = self.get_input_value(op.input_b, state)
                        
                        # Evaluate condition
                        condition = False
                        if op.operation == "if_gt":
                            condition = val_a > val_b
                        elif op.operation == "if_gte":
                            condition = val_a >= val_b
                        elif op.operation == "if_lt":
                            condition = val_a < val_b
                        elif op.operation == "if_lte":
                            condition = val_a <= val_b
                        elif op.operation == "if_eq":
                            condition = abs(val_a - val_b) < 1e-9  # Floating point equality
                        elif op.operation == "if_neq":
                            condition = abs(val_a - val_b) >= 1e-9
                        
                        # Get output based on condition
                        if condition:
                            result = self.get_input_value(op.output_true, state)
                        else:
                            result = self.get_input_value(op.output_false, state)
                
                else:
                    result = 0.0
                
                # Check for invalid results
                if not math.isfinite(result):
                    result = 0.0
                
                self.outputs[i] = result
                
                tel_data = {
                    "name": op.name or f"Math{i}",
                    "operation": op.operation,
                    "input_a": val_a,
                    "input_b": val_b,
                    "output": result,
                    "enabled": True
                }
                
                # Add filter-specific info
                if op.operation == "filter":
                    tel_data["filter_hz"] = op.filter_hz or 1.0
                    tel_data["raw_value"] = self.filter_states[i]['raw']
                
                telemetry.append(tel_data)
                
            except Exception as e:
                print(f"[MathOps] Error evaluating {op.name}: {e}")
                self.outputs[i] = 0.0
                telemetry.append({
                    "name": op.name or f"Math{i}",
                    "operation": op.operation,
                    "input_a": 0.0,
                    "input_b": None,
                    "output": 0.0,
                    "enabled": True,
                    "error": str(e)
                })
        
        # Write outputs to hardware if configured
        if bridge is not None:
            for i, op in enumerate(self.operators):
                # Skip if not enabled or no output configured
                if not op.enabled:
                    continue
                if not getattr(op, 'has_output', False):
                    continue
                if not getattr(op, 'output_type', None):
                    continue
                if getattr(op, 'output_channel', None) is None:
                    continue
                
                result = self.outputs[i]
                
                try:
                    if op.output_type == "ao":
                        # Clamp to min/max
                        if op.output_min is not None:
                            result = max(op.output_min, result)
                        if op.output_max is not None:
                            result = min(op.output_max, result)
                        
                        # Write to AO
                        bridge.set_ao(op.output_channel, result)
                    
                    elif op.output_type == "do":
                        # Convert to boolean: >= 1 is ON
                        do_state = result >= 1.0
                        bridge.set_do(op.output_channel, do_state, active_high=True)
                
                except Exception as e:
                    print(f"[MathOps] Error writing output for {op.name}: {e}")
                    import traceback
                    traceback.print_exc()
        
        # Update timestamp for next iteration
        import time
        self.last_time = time.time()
        
        return telemetry
