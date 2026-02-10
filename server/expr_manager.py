"""
Expression Manager - Handles expression storage and evaluation
Version: 1.0.2 (2026-01-27)
- Added execution_rate_hz for per-expression decimation (like PIDs)
- Expressions can run at 10-100 Hz independently
"""
__version__ = "1.0.2"
__updated__ = "2026-01-27"

import json
from pathlib import Path
from typing import List, Dict, Any, Optional
from dataclasses import dataclass, field, asdict
from expr_engine import evaluate_expression, global_vars


@dataclass
class Expression:
    """Single expression definition"""
    name: str = ""
    enabled: bool = True
    expression: str = ""
    execution_rate_hz: Optional[float] = None  # None = run at sample rate, else decimate


class ExpressionManager:
    """Manage expressions and their evaluation"""
    
    def __init__(self, filepath: str = "data/expressions.json"):
        self.filepath = Path(filepath)
        self.expressions: List[Expression] = []
        self.outputs: List[float] = []  # Cached outputs
        self.tick_counters: List[int] = []  # For execution rate decimation
        self.last_telemetry: List[Dict] = []  # Cache telemetry for skipped cycles
        self.load()
    
    def load(self):
        """Load expressions from file"""
        if not self.filepath.exists():
            self.expressions = []
            return
        
        try:
            with open(self.filepath) as f:
                data = json.load(f)
                self.expressions = [
                    Expression(**expr) for expr in data.get('expressions', [])
                ]
                self.outputs = [0.0] * len(self.expressions)
                self.tick_counters = [0] * len(self.expressions)
                self.last_telemetry = [{}] * len(self.expressions)
        except Exception as e:
            print(f"[EXPR] Error loading expressions: {e}")
            self.expressions = []
    
    def save(self):
        """Save expressions to file"""
        self.filepath.parent.mkdir(parents=True, exist_ok=True)
        
        try:
            with open(self.filepath, 'w') as f:
                json.dump({
                    'expressions': [asdict(expr) for expr in self.expressions]
                }, f, indent=2)
        except Exception as e:
            print(f"[EXPR] Error saving expressions: {e}")
    
    def evaluate_all(self, signal_state: Dict[str, Any], bridge=None, sample_rate_hz: float = 100.0) -> List[Dict]:
        """Evaluate all enabled expressions and return telemetry"""
        telemetry = []
        
        # Add expression list to state so expressions can reference each other
        signal_state['expr_list'] = [{'name': expr.name} for expr in self.expressions]
        signal_state['expr'] = self.outputs.copy()
        
        for i, expr in enumerate(self.expressions):
            if not expr.enabled:
                self.outputs[i] = 0.0
                self.tick_counters[i] = 0
                telemetry.append({
                    'name': expr.name,
                    'output': 0.0,
                    'enabled': False,
                    'error': None
                })
                continue
            
            # Check if this expression should execute this cycle (decimation)
            should_execute = True
            if expr.execution_rate_hz is not None and expr.execution_rate_hz > 0:
                # Calculate decimation factor
                decimate = max(1, int(round(sample_rate_hz / expr.execution_rate_hz)))
                self.tick_counters[i] += 1
                should_execute = (self.tick_counters[i] >= decimate)
                if should_execute:
                    self.tick_counters[i] = 0
            
            # If not executing this cycle, return cached telemetry
            if not should_execute:
                # Return last telemetry with skipped flag
                cached = self.last_telemetry[i].copy() if i < len(self.last_telemetry) else {}
                cached['skipped'] = True
                telemetry.append(cached)
                continue
            
            try:
                # Evaluate expression
                result, local_vars, hw_writes, branch_paths, executed_lines = evaluate_expression(expr.expression, signal_state)
                
                # Store output
                self.outputs[i] = result
                
                # Update state so later expressions can reference this one
                signal_state['expr'] = self.outputs.copy()
                
                # Apply hardware writes if bridge is available
                if bridge and hw_writes:
                    for write in hw_writes:
                        try:
                            if write['type'] == 'do':
                                bridge.set_do(write['channel'], write['value'], active_high=True)
                            elif write['type'] == 'ao':
                                bridge.set_ao(write['channel'], write['value'])
                        except Exception as e:
                            print(f"[EXPR] Failed to apply hardware write: {e}")
                
                # Convert branch_paths keys (node IDs) to line numbers for frontend
                # This is a simple approach - we'll track by source line later
                branch_info = {}
                for node_id, path in branch_paths.items():
                    branch_info[str(node_id)] = path  # Convert to string for JSON
                
                telem = {
                    'name': expr.name,
                    'output': result,
                    'enabled': True,
                    'error': None,
                    'locals': local_vars,
                    'hw_writes': hw_writes,
                    'branches': branch_info,
                    'executed_lines': list(executed_lines)  # Convert set to list for JSON
                }
                
                # Cache telemetry for skipped cycles
                self.last_telemetry[i] = telem
                telemetry.append(telem)
            
            except Exception as e:
                print(f"[EXPR] Error evaluating '{expr.name}': {e}")
                self.outputs[i] = 0.0
                telemetry.append({
                    'name': expr.name,
                    'output': 0.0,
                    'enabled': True,
                    'error': str(e)
                })
        
        return telemetry
    
    def check_syntax(self, expression: str, signal_state: Optional[Dict] = None) -> Dict:
        """Check expression syntax, validate signal references, and return result"""
        if signal_state is None:
            # Create minimal test state
            signal_state = {
                'ai_list': [],
                'ai': [],
                'ao_list': [],
                'ao': [],
                'tc_list': [],
                'tc': [],
                'do_list': [],
                'do': [],
                'pid_list': [],
                'pid': [],
                'math_list': [],
                'math': [],
                'le_list': [],
                'le': [],
                'expr_list': [],
                'expr': [],
                'time': 0.0,
                'sample': 0
            }
        
        warnings = []
        
        # Extract signal references from expression
        import re
        signal_pattern = r'"(AI|AO|TC|DO|PID|LE|Math|Expr):([^"]+)"'
        matches = re.findall(signal_pattern, expression, re.IGNORECASE)
        
        # Build available signal names
        available_signals = {
            'AI': [item['name'] for item in signal_state.get('ai_list', [])],
            'AO': [item['name'] for item in signal_state.get('ao_list', [])],
            'TC': [item['name'] for item in signal_state.get('tc_list', [])],
            'DO': [item['name'] for item in signal_state.get('do_list', [])],
            'PID': [item['name'] for item in signal_state.get('pid_list', [])],
            'LE': [item['name'] for item in signal_state.get('le_list', [])],
            'Math': [item['name'] for item in signal_state.get('math_list', [])],
            'Expr': [item['name'] for item in signal_state.get('expr_list', [])]
        }
        
        # Validate each signal reference
        for sig_type, sig_name in matches:
            sig_type_proper = sig_type.upper()
            # Normalize Math and Expr
            if sig_type_proper == 'MATH':
                sig_type_proper = 'Math'
            elif sig_type_proper == 'EXPR':
                sig_type_proper = 'Expr'
            
            available = available_signals.get(sig_type_proper, [])
            
            if sig_name not in available:
                # Find close matches
                close_matches = []
                sig_name_lower = sig_name.lower()
                for avail_name in available:
                    if sig_name_lower in avail_name.lower() or avail_name.lower() in sig_name_lower:
                        close_matches.append(avail_name)
                
                if close_matches:
                    warnings.append({
                        'type': 'unknown_signal',
                        'signal': f'{sig_type}:{sig_name}',
                        'message': f'Signal "{sig_type}:{sig_name}" not found. Did you mean: {", ".join(close_matches[:3])}?'
                    })
                else:
                    available_list = ', '.join(available[:5])
                    more = f' (+{len(available)-5} more)' if len(available) > 5 else ''
                    warnings.append({
                        'type': 'unknown_signal',
                        'signal': f'{sig_type}:{sig_name}',
                        'message': f'Signal "{sig_type}:{sig_name}" not found. Available {sig_type} signals: {available_list}{more}'
                    })
        
        try:
            result, local_vars, hw_writes, branch_paths, executed_lines = evaluate_expression(expression, signal_state)
            return {
                'ok': True,
                'result': result,
                'locals': local_vars,
                'hw_writes': hw_writes,
                'branches': branch_paths,
                'executed_lines': list(executed_lines),
                'warnings': warnings,
                'error': None
            }
        except Exception as e:
            return {
                'ok': False,
                'result': 0.0,
                'locals': {},
                'hw_writes': [],
                'warnings': warnings,
                'error': str(e)
            }
    
    def to_dict(self) -> Dict:
        """Convert to dictionary for API"""
        return {
            'expressions': [asdict(expr) for expr in self.expressions]
        }
    
    def from_dict(self, data: Dict):
        """Load from dictionary (API)"""
        self.expressions = [
            Expression(**expr) for expr in data.get('expressions', [])
        ]
        self.outputs = [0.0] * len(self.expressions)
        self.tick_counters = [0] * len(self.expressions)
        self.last_telemetry = [{}] * len(self.expressions)
        self.save()
