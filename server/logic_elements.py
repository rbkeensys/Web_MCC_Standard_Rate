# server/logic_elements.py
"""
Logic Elements (LE) system for conditional control
"""
from dataclasses import dataclass
from typing import List, Dict, Optional, Any
from enum import Enum

class ComparisonOp(str, Enum):
    LESS_THAN = "lt"
    EQUAL = "eq"
    GREATER_THAN = "gt"

class LogicOp(str, Enum):
    AND = "and"
    OR = "or"
    XOR = "xor"
    NAND = "nand"
    NOR = "nor"
    NXOR = "nxor"

@dataclass
class LEInput:
    """Represents one input to a logic element"""
    kind: str  # "do", "ai", "ao", "tc", "pid_u", "le"
    index: int
    # For analog inputs (ai, ao, tc, pid_u):
    comparison: Optional[str] = None  # "lt", "eq", "gt"
    compare_to_type: Optional[str] = None  # "value" or "signal"
    compare_value: Optional[float] = None  # if comparing to fixed value
    compare_to_kind: Optional[str] = None  # if comparing to another signal
    compare_to_index: Optional[int] = None

@dataclass
class LogicElement:
    """A logic element that combines two inputs"""
    enabled: bool
    name: str
    input_a: LEInput
    input_b: LEInput
    operation: str  # "and", "or", "xor", "nand", "nor", "nxor"
    
class LEManager:
    """Manages logic element evaluation"""
    
    def __init__(self):
        self.elements: List[LogicElement] = []
        self.outputs: List[bool] = []  # Cached outputs from last evaluation
    
    def load(self, le_data: Dict):
        """Load logic elements from config"""
        self.elements.clear()
        elements = le_data.get("elements", [])
        
        for elem_dict in elements:
            try:
                # Parse input A
                input_a_dict = elem_dict.get("input_a", {})
                input_a = LEInput(
                    kind=input_a_dict.get("kind", "do"),
                    index=input_a_dict.get("index", 0),
                    comparison=input_a_dict.get("comparison"),
                    compare_to_type=input_a_dict.get("compare_to_type"),
                    compare_value=input_a_dict.get("compare_value"),
                    compare_to_kind=input_a_dict.get("compare_to_kind"),
                    compare_to_index=input_a_dict.get("compare_to_index")
                )
                
                # Parse input B
                input_b_dict = elem_dict.get("input_b", {})
                input_b = LEInput(
                    kind=input_b_dict.get("kind", "do"),
                    index=input_b_dict.get("index", 0),
                    comparison=input_b_dict.get("comparison"),
                    compare_to_type=input_b_dict.get("compare_to_type"),
                    compare_value=input_b_dict.get("compare_value"),
                    compare_to_kind=input_b_dict.get("compare_to_kind"),
                    compare_to_index=input_b_dict.get("compare_to_index")
                )
                
                elem = LogicElement(
                    enabled=elem_dict.get("enabled", True),
                    name=elem_dict.get("name", f"LE{len(self.elements)}"),
                    input_a=input_a,
                    input_b=input_b,
                    operation=elem_dict.get("operation", "and")
                )
                
                self.elements.append(elem)
            except Exception as e:
                print(f"[LE] Failed to load element: {e}")
                continue
        
        self.outputs = [False] * len(self.elements)
        print(f"[LE] Loaded {len(self.elements)} logic elements")
    
    def evaluate_input(self, inp: LEInput, state: Dict) -> bool:
        """Evaluate a single input to boolean"""
        try:
            if inp.kind == "do":
                # Digital output is already boolean
                do_vals = state.get("do", [])
                if inp.index < len(do_vals):
                    return bool(do_vals[inp.index])
                return False
            
            elif inp.kind == "le":
                # Reference to another LE output
                if inp.index < len(self.outputs):
                    return self.outputs[inp.index]
                return False
            
            elif inp.kind in ["ai", "ao", "tc", "pid_u"]:
                # Get the analog value
                if inp.kind == "ai":
                    vals = state.get("ai", [])
                elif inp.kind == "ao":
                    vals = state.get("ao", [])
                elif inp.kind == "tc":
                    vals = state.get("tc", [])
                elif inp.kind == "pid_u":
                    # Get PID output value
                    pid_vals = state.get("pid", [])
                    if inp.index < len(pid_vals):
                        val = pid_vals[inp.index].get("u", 0.0)
                    else:
                        val = 0.0
                    vals = [val]  # Wrap in list for consistent handling
                else:
                    return False
                
                if inp.index >= len(vals):
                    return False
                
                value = vals[inp.index]
                
                # CRITICAL: Treat NaN as False (missing/disconnected sensors)
                import math
                if not math.isfinite(value):
                    return False
                
                # Determine comparison value
                if inp.compare_to_type == "value":
                    compare_val = inp.compare_value if inp.compare_value is not None else 0.0
                elif inp.compare_to_type == "signal":
                    # Compare to another signal
                    if inp.compare_to_kind == "ai":
                        cvals = state.get("ai", [])
                    elif inp.compare_to_kind == "ao":
                        cvals = state.get("ao", [])
                    elif inp.compare_to_kind == "tc":
                        cvals = state.get("tc", [])
                    elif inp.compare_to_kind == "pid_u":
                        pid_vals = state.get("pid", [])
                        if inp.compare_to_index < len(pid_vals):
                            compare_val = pid_vals[inp.compare_to_index].get("u", 0.0)
                        else:
                            compare_val = 0.0
                        cvals = [compare_val]
                    else:
                        compare_val = 0.0
                        cvals = [compare_val]
                    
                    if inp.compare_to_index is not None and inp.compare_to_index < len(cvals):
                        compare_val = cvals[inp.compare_to_index]
                        # Also check if comparison value is NaN
                        if not math.isfinite(compare_val):
                            return False
                    else:
                        compare_val = 0.0
                else:
                    compare_val = 0.0
                
                # Perform comparison
                if inp.comparison == "lt":
                    return value < compare_val
                elif inp.comparison == "eq":
                    return abs(value - compare_val) < 1e-6  # Tolerance for float comparison
                elif inp.comparison == "gt":
                    return value > compare_val
                else:
                    return False
            
            return False
            
        except Exception as e:
            print(f"[LE] Error evaluating input: {e}")
            return False
    
    def evaluate_operation(self, a: bool, b: bool, op: str) -> bool:
        """Perform logic operation on two boolean inputs"""
        if op == "and":
            return a and b
        elif op == "or":
            return a or b
        elif op == "xor":
            return a != b
        elif op == "nand":
            return not (a and b)
        elif op == "nor":
            return not (a or b)
        elif op == "nxor":
            return a == b
        else:
            return False
    
    def evaluate_all(self, state: Dict) -> List[bool]:
        """
        Evaluate all logic elements in order.
        Returns list of boolean outputs.
        State should contain: ai, ao, do, tc, pid
        """
        # Reset outputs
        self.outputs = [False] * len(self.elements)
        
        # Evaluate each element in sequence (allowing cascading)
        for i, elem in enumerate(self.elements):
            if not elem.enabled:
                self.outputs[i] = False
                continue
            
            try:
                # Evaluate both inputs
                a = self.evaluate_input(elem.input_a, state)
                b = self.evaluate_input(elem.input_b, state)
                
                # Perform logic operation
                result = self.evaluate_operation(a, b, elem.operation)
                self.outputs[i] = result
                
            except Exception as e:
                print(f"[LE] Error evaluating element {i} '{elem.name}': {e}")
                self.outputs[i] = False
        
        return self.outputs
    
    def get_output(self, index: int) -> bool:
        """Get the output of a specific logic element"""
        if 0 <= index < len(self.outputs):
            return self.outputs[index]
        return False
    
    def get_telemetry(self) -> List[Dict]:
        """Get telemetry data for all logic elements"""
        telemetry = []
        for i, elem in enumerate(self.elements):
            telemetry.append({
                "name": elem.name,
                "enabled": elem.enabled,
                "output": self.outputs[i] if i < len(self.outputs) else False,
                "operation": elem.operation
            })
        return telemetry
