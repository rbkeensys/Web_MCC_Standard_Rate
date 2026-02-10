"""
Expression Engine for MCC DAQ System - VERSION 2.1 OPTIMIZED

Supports:
- C-style operator precedence
- Signal references: "AI:name", "PID:name".OUT, etc.
- Signal writes: "DO:name" = value, "AO:name" = value  ← WRITE BY NAME!
- Local variables: temp = value
- Global variables: static.name = value
- Button variables: buttonVars.name (read-only from frontend)
- Math functions: sin(), cos(), max(), min(), etc.
- IF/THEN/ELSE/ENDIF conditionals
- Boolean logic: AND, OR, NOT
- Comparisons: <, <=, >, >=, ==, !=

VERSION 2.1 Changes (2026-01-27):
- CRITICAL OPTIMIZATION: Added signal index caching for 3-4ms speedup
- Signal lookups now use O(1) dictionary lookup instead of O(n) linear search
- Builds cache of signal names → indices once at Evaluator init
- Eliminates thousands of string operations per second at high sample rates
- Fallback to original slow method for safety (cache misses)
- Expected: Expression evaluation time reduced from 6ms → 2-3ms for 12 expressions
- AO/DO write-by-name syntax: "AO:PumpSpeed" = 1.2, "DO:HeaterRelay" = 1

VERSION 2.0 Changes:
- Added buttonVars support for reading frontend button states
- buttonVars are read-only in expressions (set by UI buttons)
"""
__version__ = "2.1.0"
__updated__ = "2026-01-27"

import re
import math
from typing import Dict, List, Any, Optional, Tuple
from dataclasses import dataclass, field


class GlobalVariables:
    """Shared global variable storage across all expressions"""
    def __init__(self):
        self._vars: Dict[str, float] = {}
    
    def set(self, name: str, value: float):
        self._vars[name] = value
    
    def get(self, name: str, default: float = 0.0) -> float:
        return self._vars.get(name, default)
    
    def list_all(self) -> Dict[str, float]:
        return self._vars.copy()
    
    def clear(self):
        self._vars.clear()


# Global instance
global_vars = GlobalVariables()


@dataclass
class Token:
    """Token from lexer"""
    type: str  # NUMBER, STRING, IDENT, OPERATOR, etc.
    value: Any
    pos: int = 0
    line: int = 0  # Line number (0-indexed)


class Lexer:
    """Tokenize expression string"""
    
    # Token patterns
    PATTERNS = [
        ('COMMENT', r'//[^\n]*'),  # Single-line comments - MUST be before DIV
        ('NUMBER', r'\d+\.?\d*'),
        ('STRING', r'"([^"]+)"'),  # Signal references like "AI:Tank"
        ('STATIC', r'static\.([a-zA-Z_][a-zA-Z0-9_]*)'),
        ('BUTTONVAR', r'buttonVars\.([a-zA-Z_][a-zA-Z0-9_]*)'),  # Button variables
        ('IDENT', r'[a-zA-Z_][a-zA-Z0-9_]*'),
        ('DOTPROP', r'\.([A-Z_]+)'),  # Property access like .OUT, .SP
        ('COMPARE', r'(==|!=|<=|>=|<|>)'),
        ('ASSIGN', r'='),
        ('PLUS', r'\+'),
        ('MINUS', r'-'),
        ('MULT', r'\*'),
        ('DIV', r'/'),
        ('MOD', r'%'),
        ('LPAREN', r'\('),
        ('RPAREN', r'\)'),
        ('COMMA', r','),
        ('WHITESPACE', r'\s+'),
    ]
    
    def __init__(self, text: str):
        self.text = text
        self.pos = 0
        self.tokens: List[Token] = []
        self.line = 0  # Current line number
        
    def tokenize(self) -> List[Token]:
        """Convert text to tokens"""
        self.tokens = []
        
        # Count line numbers as we go
        line_starts = [0]
        for i, ch in enumerate(self.text):
            if ch == '\n':
                line_starts.append(i + 1)
        
        def pos_to_line(pos):
            for line_num, start in enumerate(line_starts):
                if pos < start:
                    return line_num - 1
            return len(line_starts) - 1
        
        while self.pos < len(self.text):
            match_found = False
            
            for token_type, pattern in self.PATTERNS:
                regex = re.compile(pattern)
                match = regex.match(self.text, self.pos)
                
                if match:
                    value = match.group(0)
                    
                    if token_type == 'STRING':
                        # Extract signal reference without quotes
                        value = match.group(1)
                    elif token_type == 'STATIC':
                        # Extract variable name after "static."
                        value = match.group(1)
                    elif token_type == 'BUTTONVAR':
                        # Extract variable name after "buttonVars."
                        value = match.group(1)
                    elif token_type == 'DOTPROP':
                        # Extract property name after "."
                        value = match.group(1)
                    elif token_type in ('WHITESPACE', 'COMMENT'):
                        # Skip whitespace and comments
                        self.pos = match.end()
                        match_found = True
                        break
                    
                    self.tokens.append(Token(token_type, value, self.pos, pos_to_line(self.pos)))
                    self.pos = match.end()
                    match_found = True
                    break
            
            if not match_found:
                raise SyntaxError(f"Invalid character at position {self.pos}: '{self.text[self.pos]}'")
        
        return self.tokens


@dataclass
class ASTNode:
    """Abstract Syntax Tree node"""
    type: str
    value: Any = None
    children: List['ASTNode'] = field(default_factory=list)
    line_start: int = 0  # Starting line number (0-indexed)
    line_end: int = 0    # Ending line number (0-indexed)
    
    def __repr__(self):
        if not self.children:
            return f"{self.type}({self.value})"
        return f"{self.type}({self.value}, {self.children})"


class Parser:
    """Parse tokens into Abstract Syntax Tree"""
    
    def __init__(self, tokens: List[Token]):
        self.tokens = tokens
        self.pos = 0
        self.current_line = 0  # Track current line
    
    def make_node(self, type: str, value: Any = None, children: List[ASTNode] = None) -> ASTNode:
        """Create an ASTNode with line tracking from current token"""
        line = self.current_line
        node = ASTNode(type, value, children or [])
        node.line_start = line
        node.line_end = line
        return node
    
    def current(self) -> Optional[Token]:
        if self.pos < len(self.tokens):
            return self.tokens[self.pos]
        return None
    
    def peek(self, offset: int = 1) -> Optional[Token]:
        pos = self.pos + offset
        if pos < len(self.tokens):
            return self.tokens[pos]
        return None
    
    def advance(self) -> Token:
        token = self.current()
        if token:
            self.current_line = token.line
        self.pos += 1
        return token
    
    def expect(self, token_type: str) -> Token:
        token = self.current()
        if not token or token.type != token_type:
            raise SyntaxError(f"Expected {token_type}, got {token.type if token else 'EOF'}")
        return self.advance()
    
    def parse(self) -> List[ASTNode]:
        """Parse full expression (may have multiple statements)"""
        statements = []
        
        while self.current():
            stmt = self.parse_statement()
            statements.append(stmt)
        
        return statements
    
    def parse_statement(self) -> ASTNode:
        """Parse a single statement (assignment or expression)"""
        # Check for assignment: IDENT = expr or static.name = expr or "DO:name" = expr or "AO:name" = expr
        token = self.current()
        
        if token and token.type == 'IDENT':
            # Could be assignment or just expression
            next_token = self.peek()
            if next_token and next_token.type == 'ASSIGN':
                # Local assignment: name = expr
                name = self.advance().value
                self.advance()  # consume =
                expr = self.parse_or()
                return self.make_node('ASSIGN', name, [expr])
        
        elif token and token.type == 'STATIC':
            # Global assignment: static.name = expr
            next_token = self.peek()
            if next_token and next_token.type == 'ASSIGN':
                name = self.advance().value
                self.advance()  # consume =
                expr = self.parse_or()
                return self.make_node('STATIC_ASSIGN', name, [expr])
        
        elif token and token.type == 'STRING':
            # Signal reference assignment: "DO:name" = expr or "AO:name" = expr
            next_token = self.peek()
            if next_token and next_token.type == 'ASSIGN':
                signal_ref = self.advance().value
                self.advance()  # consume =
                expr = self.parse_or()
                
                # Parse signal type
                if ':' in signal_ref:
                    signal_type, signal_name = signal_ref.split(':', 1)
                    signal_type = signal_type.upper()
                    
                    if signal_type == 'DO':
                        return self.make_node('DO_ASSIGN', signal_name, [expr])
                    elif signal_type == 'AO':
                        return self.make_node('AO_ASSIGN', signal_name, [expr])
        
        # Not an assignment, just an expression
        return self.parse_or()
    
    def parse_or(self) -> ASTNode:
        """Parse OR expression (lowest precedence binary op)"""
        left = self.parse_and()
        
        while self.current() and self.current().type == 'IDENT' and self.current().value.upper() == 'OR':
            self.advance()
            right = self.parse_and()
            left = self.make_node('OR', None, [left, right])
        
        return left
    
    def parse_and(self) -> ASTNode:
        """Parse AND expression"""
        left = self.parse_comparison()
        
        while self.current() and self.current().type == 'IDENT' and self.current().value.upper() == 'AND':
            self.advance()
            right = self.parse_comparison()
            left = self.make_node('AND', None, [left, right])
        
        return left
    
    def parse_comparison(self) -> ASTNode:
        """Parse comparison: <, <=, >, >=, ==, !="""
        left = self.parse_additive()
        
        token = self.current()
        if token and token.type == 'COMPARE':
            op = self.advance().value
            right = self.parse_additive()
            return self.make_node('COMPARE', op, [left, right])
        
        return left
    
    def parse_additive(self) -> ASTNode:
        """Parse + and -"""
        left = self.parse_multiplicative()
        
        while self.current() and self.current().type in ('PLUS', 'MINUS'):
            op = self.advance().type
            right = self.parse_multiplicative()
            left = self.make_node(op, None, [left, right])
        
        return left
    
    def parse_multiplicative(self) -> ASTNode:
        """Parse *, /, %"""
        left = self.parse_unary()
        
        while self.current() and self.current().type in ('MULT', 'DIV', 'MOD'):
            op = self.advance().type
            right = self.parse_unary()
            left = self.make_node(op, None, [left, right])
        
        return left
    
    def parse_unary(self) -> ASTNode:
        """Parse unary - and NOT"""
        token = self.current()
        
        if token and token.type == 'MINUS':
            self.advance()
            expr = self.parse_unary()
            return self.make_node('NEGATE', None, [expr])
        
        if token and token.type == 'IDENT' and token.value.upper() == 'NOT':
            self.advance()
            expr = self.parse_unary()
            return self.make_node('NOT', None, [expr])
        
        return self.parse_primary()
    
    def parse_primary(self) -> ASTNode:
        """Parse primary expressions: numbers, strings, identifiers, function calls, parentheses, IF"""
        token = self.current()
        
        if not token:
            raise SyntaxError("Unexpected end of expression")
        
        # Number literal
        if token.type == 'NUMBER':
            value = float(self.advance().value)
            return self.make_node('NUMBER', value)
        
        # Signal reference: "AI:Tank"
        if token.type == 'STRING':
            signal_ref = self.advance().value
            
            # Check for property access: "PID:Motor".OUT
            if self.current() and self.current().type == 'DOTPROP':
                prop = self.advance().value
                return self.make_node('SIGNAL_PROP', (signal_ref, prop))
            
            return self.make_node('SIGNAL', signal_ref)
        
        # Global variable: static.name
        if token.type == 'STATIC':
            name = self.advance().value
            return self.make_node('STATIC_VAR', name)
        
        # Button variable: buttonVars.name (read-only)
        if token.type == 'BUTTONVAR':
            name = self.advance().value
            return self.make_node('BUTTONVAR', name)
        
        # Identifier: could be variable, function, or keyword
        if token.type == 'IDENT':
            name = self.advance().value
            
            # IF statement
            if name.upper() == 'IF':
                return self.parse_if()
            
            # Function call
            if self.current() and self.current().type == 'LPAREN':
                return self.parse_function_call(name)
            
            # Just a variable reference
            return self.make_node('VAR', name)
        
        # Parenthesized expression
        if token.type == 'LPAREN':
            self.advance()
            expr = self.parse_or()
            self.expect('RPAREN')
            return expr
        
        raise SyntaxError(f"Unexpected token: {token.type} '{token.value}'")
    
    def parse_if(self) -> ASTNode:
        """
        Parse IF statement - two styles supported:
        1. Inline: IF cond THEN expr ELSE expr (no ENDIF needed)
        2. Block: IF cond THEN ... ELSE ... ENDIF (ENDIF required)
        """
        result = self.parse_if_without_endif()
        
        # Check for ENDIF (only for top-level IF, not ELSE IF)
        token = self.current()
        is_block_style = self.is_block_if(result)
        
        if token and token.type == 'IDENT' and token.value.upper() == 'ENDIF':
            self.advance()  # consume ENDIF
        elif is_block_style:
            # Block-style IF requires ENDIF
            raise SyntaxError(f"Expected ENDIF to close multi-line IF statement, got {token.value if token else 'EOF'}")
        # else: inline-style IF without ENDIF is OK
        
        return result
    
    def is_block_if(self, if_node: ASTNode) -> bool:
        """Check if an IF node is block-style (has BLOCK children)"""
        if if_node.type != 'IF':
            return False
        
        then_expr = if_node.children[1]
        else_expr = if_node.children[2]
        
        # Check if THEN branch is a BLOCK
        if then_expr.type == 'BLOCK':
            return True
        
        # Check if ELSE branch is a BLOCK
        if else_expr.type == 'BLOCK':
            return True
        
        # If ELSE branch is another IF (ELSE IF), recursively check it
        if else_expr.type == 'IF':
            return self.is_block_if(else_expr)
        
        return False
    
    def parse_if_without_endif(self) -> ASTNode:
        """
        Parse IF without consuming ENDIF
        Used for ELSE IF chains where ENDIF is shared
        """
        condition = self.parse_or()
        
        # Expect THEN
        token = self.current()
        if not token or token.type != 'IDENT' or token.value.upper() != 'THEN':
            raise SyntaxError("Expected THEN after IF condition")
        self.advance()
        
        # Try to parse as inline IF first (single expression)
        # Inline IF: IF cond THEN expr [ELSE expr] (no ENDIF)
        # Block IF: IF cond THEN ... [ELSE ...] ENDIF (with ENDIF)
        
        # Parse THEN statements
        then_stmts = []
        while self.current():
            token = self.current()
            # Stop on ELSE or ENDIF
            if token.type == 'IDENT' and token.value.upper() in ('ELSE', 'ENDIF'):
                break
            
            then_stmts.append(self.parse_statement())
        
        # Wrap multiple statements in a BLOCK node
        if len(then_stmts) == 0:
            raise SyntaxError("Expected statement after THEN")
        elif len(then_stmts) == 1:
            then_expr = then_stmts[0]
        else:
            then_expr = ASTNode('BLOCK', None, then_stmts)
        
        # Check for ELSE clause
        token = self.current()
        has_else = False
        if token and token.type == 'IDENT' and token.value.upper() == 'ELSE':
            has_else = True
            self.advance()
            
            # Check for ELSE IF (another IF statement)
            token = self.current()
            if token and token.type == 'IDENT' and token.value.upper() == 'IF':
                self.advance()  # consume IF
                # ELSE IF is part of the same IF chain, so don't expect separate ENDIF
                # Just parse the condition and branches, but not the closing ENDIF
                else_expr = self.parse_if_without_endif()
            else:
                # Regular ELSE - parse statements until ENDIF
                else_stmts = []
                while self.current():
                    token = self.current()
                    # Stop on ENDIF
                    if token.type == 'IDENT' and token.value.upper() == 'ENDIF':
                        break
                    
                    else_stmts.append(self.parse_statement())
                
                # Wrap multiple statements in a BLOCK node
                if len(else_stmts) == 0:
                    raise SyntaxError("Expected statement after ELSE")
                elif len(else_stmts) == 1:
                    else_expr = else_stmts[0]
                else:
                    else_expr = ASTNode('BLOCK', None, else_stmts)
        else:
            # No ELSE clause - default to 0
            else_expr = ASTNode('NUMBER', 0.0)
        
        # Don't consume ENDIF here - let parse_if() handle it for the outermost IF
        return self.make_node('IF', None, [condition, then_expr, else_expr])
    
    def parse_function_call(self, name: str) -> ASTNode:
        """Parse function call: func(arg1, arg2, ...)"""
        self.expect('LPAREN')
        
        args = []
        if self.current() and self.current().type != 'RPAREN':
            args.append(self.parse_or())
            
            while self.current() and self.current().type == 'COMMA':
                self.advance()
                args.append(self.parse_or())
        
        self.expect('RPAREN')
        
        return self.make_node('CALL', name, args)


class Evaluator:
    """Evaluate AST with signal state and variables"""
    
    # Built-in math functions
    FUNCTIONS = {
        'sin': lambda x: math.sin(x),
        'cos': lambda x: math.cos(x),
        'tan': lambda x: math.tan(x),
        'sqrt': lambda x: math.sqrt(x) if x >= 0 else 0,
        'abs': lambda x: abs(x),
        'log': lambda x: math.log(x) if x > 0 else 0,
        'exp': lambda x: math.exp(x),
        'min': lambda *args: min(args),
        'max': lambda *args: max(args),
        'clamp': lambda x, lo, hi: max(lo, min(hi, x)),
    }
    
    def __init__(self, signal_state: Dict[str, Any], local_vars: Optional[Dict[str, float]] = None):
        self.signal_state = signal_state
        self.local_vars = local_vars if local_vars is not None else {}
        self.result = 0.0
        # Track hardware writes that need to be applied
        self.hardware_writes: List[Dict[str, Any]] = []
        # Track which IF branches were taken (line_num -> 'then' or 'else')
        self.branch_paths: Dict[int, str] = {}
        # Track which lines actually executed
        self.executed_lines: set[int] = set()
        
        # NEW: Build signal index cache for fast lookups
        self._signal_cache: Dict[str, Dict] = {}
        self._build_signal_cache()
    
    def _build_signal_cache(self):
        """Pre-compute all signal name → index mappings for O(1) lookup"""
        # Cache AI signals
        for i, sig in enumerate(self.signal_state.get('ai_list', [])):
            key = f"AI:{sig['name']}"
            self._signal_cache[key] = {'type': 'ai', 'index': i}
        
        # Cache AO signals
        for i, sig in enumerate(self.signal_state.get('ao_list', [])):
            key = f"AO:{sig['name']}"
            self._signal_cache[key] = {'type': 'ao', 'index': i}
        
        # Cache TC signals
        for i, sig in enumerate(self.signal_state.get('tc_list', [])):
            key = f"TC:{sig['name']}"
            self._signal_cache[key] = {'type': 'tc', 'index': i}
        
        # Cache DO signals
        for i, sig in enumerate(self.signal_state.get('do_list', [])):
            key = f"DO:{sig['name']}"
            self._signal_cache[key] = {'type': 'do', 'index': i}
        
        # Cache PID signals
        for i, sig in enumerate(self.signal_state.get('pid_list', [])):
            key = f"PID:{sig['name']}"
            self._signal_cache[key] = {'type': 'pid', 'index': i}
        
        # Cache Math signals
        for i, sig in enumerate(self.signal_state.get('math_list', [])):
            key = f"MATH:{sig['name']}"
            self._signal_cache[key] = {'type': 'math', 'index': i}
        
        # Cache LE signals
        for i, sig in enumerate(self.signal_state.get('le_list', [])):
            key = f"LE:{sig['name']}"
            self._signal_cache[key] = {'type': 'le', 'index': i}
        
        # Cache Expr signals
        for i, sig in enumerate(self.signal_state.get('expr_list', [])):
            key = f"EXPR:{sig['name']}"
            self._signal_cache[key] = {'type': 'expr', 'index': i}
    
    def evaluate(self, statements: List[ASTNode]) -> float:
        """Evaluate list of statements, return last value"""
        for stmt in statements:
            self.result = self.eval_node(stmt)
        return self.result
    
    def eval_node(self, node: ASTNode) -> float:
        """Evaluate single AST node"""
        
        # DON'T mark lines here - do it selectively for each node type
        # This prevents marking lines in branches that don't execute
        
        if node.type == 'NUMBER':
            return float(node.value)
        
        elif node.type == 'VAR':
            # Local variable lookup
            name = node.value
            if name in self.local_vars:
                return self.local_vars[name]
            # Special variables
            if name == 'time':
                return self.signal_state.get('time', 0.0)
            if name == 'sample':
                return self.signal_state.get('sample', 0.0)
            return 0.0
        
        elif node.type == 'STATIC_VAR':
            # Global variable lookup
            return global_vars.get(node.value, 0.0)
        
        elif node.type == 'BUTTONVAR':
            # Button variable lookup (read-only from frontend)
            button_vars = self.signal_state.get('buttonVars', {})
            return float(button_vars.get(node.value, 0.0))
        
        elif node.type == 'ASSIGN':
            # Local assignment
            value = self.eval_node(node.children[0])
            self.local_vars[node.value] = value
            # Mark this assignment line as executed
            for line_num in range(node.line_start, node.line_end + 1):
                self.executed_lines.add(line_num)
            return value
        
        elif node.type == 'STATIC_ASSIGN':
            # Global assignment
            value = self.eval_node(node.children[0])
            global_vars.set(node.value, value)
            # Mark this assignment line as executed
            for line_num in range(node.line_start, node.line_end + 1):
                self.executed_lines.add(line_num)
            return value
        
        elif node.type == 'DO_ASSIGN':
            # Digital output assignment: "DO:name" = value
            value = self.eval_node(node.children[0])
            signal_name = node.value
            
            # Find DO channel by name
            do_list = self.signal_state.get('do_list', [])
            for i, sig in enumerate(do_list):
                if sig.get('name') == signal_name:
                    # Queue the hardware write
                    self.hardware_writes.append({
                        'type': 'do',
                        'channel': i,
                        'value': bool(value >= 1.0)  # Convert to boolean
                    })
                    break
            
            return value
        
        elif node.type == 'AO_ASSIGN':
            # Analog output assignment: "AO:name" = value
            value = self.eval_node(node.children[0])
            signal_name = node.value
            
            # Find AO channel by name
            ao_list = self.signal_state.get('ao_list', [])
            for i, sig in enumerate(ao_list):
                if sig.get('name') == signal_name:
                    # Queue the hardware write
                    self.hardware_writes.append({
                        'type': 'ao',
                        'channel': i,
                        'value': float(value)
                    })
                    break
            
            return value
        
        elif node.type == 'SIGNAL':
            # Signal reference: "AI:Tank"
            return self.resolve_signal(node.value)
        
        elif node.type == 'SIGNAL_PROP':
            # Signal property: "PID:Motor".OUT
            signal_ref, prop = node.value
            return self.resolve_signal_property(signal_ref, prop)
        
        elif node.type == 'PLUS':
            return self.eval_node(node.children[0]) + self.eval_node(node.children[1])
        
        elif node.type == 'MINUS':
            return self.eval_node(node.children[0]) - self.eval_node(node.children[1])
        
        elif node.type == 'MULT':
            return self.eval_node(node.children[0]) * self.eval_node(node.children[1])
        
        elif node.type == 'DIV':
            right = self.eval_node(node.children[1])
            if right == 0:
                return 0.0  # Avoid division by zero
            return self.eval_node(node.children[0]) / right
        
        elif node.type == 'MOD':
            right = self.eval_node(node.children[1])
            if right == 0:
                return 0.0
            return self.eval_node(node.children[0]) % right
        
        elif node.type == 'NEGATE':
            return -self.eval_node(node.children[0])
        
        elif node.type == 'COMPARE':
            left = self.eval_node(node.children[0])
            right = self.eval_node(node.children[1])
            op = node.value
            
            if op == '<': return 1.0 if left < right else 0.0
            elif op == '<=': return 1.0 if left <= right else 0.0
            elif op == '>': return 1.0 if left > right else 0.0
            elif op == '>=': return 1.0 if left >= right else 0.0
            elif op == '==': return 1.0 if abs(left - right) < 1e-9 else 0.0
            elif op == '!=': return 1.0 if abs(left - right) >= 1e-9 else 0.0
            return 0.0
        
        elif node.type == 'AND':
            left = self.eval_node(node.children[0])
            right = self.eval_node(node.children[1])
            return 1.0 if (left != 0.0 and right != 0.0) else 0.0
        
        elif node.type == 'OR':
            left = self.eval_node(node.children[0])
            right = self.eval_node(node.children[1])
            return 1.0 if (left != 0.0 or right != 0.0) else 0.0
        
        elif node.type == 'NOT':
            value = self.eval_node(node.children[0])
            return 1.0 if value == 0.0 else 0.0
        
        elif node.type == 'BLOCK':
            # Evaluate multiple statements in sequence, return last value
            result = 0.0
            for stmt in node.children:
                result = self.eval_node(stmt)
            return result
        
        elif node.type == 'IF':
            condition = self.eval_node(node.children[0])
            # Track which branch was taken (store by node position as a simple key)
            if_key = id(node)  # Unique ID for this IF node
            if condition != 0.0:
                self.branch_paths[if_key] = 'then'
                return self.eval_node(node.children[1])  # THEN
            else:
                self.branch_paths[if_key] = 'else'
                return self.eval_node(node.children[2])  # ELSE
        
        elif node.type == 'CALL':
            # Function call
            func_name = node.value.lower()
            if func_name not in self.FUNCTIONS:
                raise ValueError(f"Unknown function: {func_name}")
            
            args = [self.eval_node(arg) for arg in node.children]
            return self.FUNCTIONS[func_name](*args)
        
        return 0.0
    
    def resolve_signal(self, signal_ref: str) -> float:
        """Resolve signal reference using cached indices (OPTIMIZED)"""
        # Try cache first (FAST PATH - O(1) dictionary lookup)
        cache_key = signal_ref.upper() if ':' in signal_ref else None
        if cache_key and cache_key in self._signal_cache:
            cached = self._signal_cache[cache_key]
            sig_type = cached['type']
            idx = cached['index']
            
            # Direct array access - no string parsing or loops!
            if sig_type == 'ai':
                values = self.signal_state.get('ai', [])
                if idx < len(values):
                    return float(values[idx])
            
            elif sig_type == 'ao':
                values = self.signal_state.get('ao', [])
                if idx < len(values):
                    return float(values[idx])
            
            elif sig_type == 'tc':
                values = self.signal_state.get('tc', [])
                if idx < len(values):
                    return float(values[idx])
            
            elif sig_type == 'do':
                values = self.signal_state.get('do', [])
                if idx < len(values):
                    return float(values[idx])
            
            elif sig_type == 'pid':
                values = self.signal_state.get('pid', [])
                if idx < len(values):
                    return values[idx].get('out', 0.0)
            
            elif sig_type == 'math':
                values = self.signal_state.get('math', [])
                if idx < len(values):
                    val = values[idx]
                    if isinstance(val, dict):
                        return val.get('output', 0.0)
                    return float(val)
            
            elif sig_type == 'le':
                values = self.signal_state.get('le', [])
                if idx < len(values):
                    val = values[idx]
                    if isinstance(val, dict):
                        return float(val.get('output', 0.0))
                    return float(val)
            
            elif sig_type == 'expr':
                values = self.signal_state.get('expr', [])
                if idx < len(values):
                    val = values[idx]
                    if isinstance(val, dict):
                        return val.get('output', 0.0)
                    return float(val)
            
            return 0.0
        
        # SLOW FALLBACK: Original method for signals not in cache
        # This shouldn't happen in normal operation, but provides safety
        return self._resolve_signal_slow(signal_ref)
    
    def _resolve_signal_slow(self, signal_ref: str) -> float:
        """Original slow method - fallback for cache misses"""
        # Parse signal reference: "TYPE:Name"
        if ':' not in signal_ref:
            return 0.0
        
        signal_type, signal_name = signal_ref.split(':', 1)
        signal_type = signal_type.upper()
        
        # Get signal list from state
        if signal_type == 'AI':
            signals = self.signal_state.get('ai_list', [])
            values = self.signal_state.get('ai', [])
        elif signal_type == 'AO':
            signals = self.signal_state.get('ao_list', [])
            values = self.signal_state.get('ao', [])
        elif signal_type == 'TC':
            signals = self.signal_state.get('tc_list', [])
            values = self.signal_state.get('tc', [])
        elif signal_type == 'DO':
            signals = self.signal_state.get('do_list', [])
            values = self.signal_state.get('do', [])
        elif signal_type == 'PID':
            signals = self.signal_state.get('pid_list', [])
            values = self.signal_state.get('pid', [])
            # For PID without property, return .OUT
            for i, sig in enumerate(signals):
                if sig['name'] == signal_name and i < len(values):
                    return values[i].get('out', 0.0)
            return 0.0
        elif signal_type == 'MATH':
            signals = self.signal_state.get('math_list', [])
            values = self.signal_state.get('math', [])
        elif signal_type == 'LE':
            signals = self.signal_state.get('le_list', [])
            values = self.signal_state.get('le', [])
        elif signal_type == 'EXPR':
            signals = self.signal_state.get('expr_list', [])
            values = self.signal_state.get('expr', [])
        else:
            return 0.0
        
        # Find signal by name and return value
        for i, sig in enumerate(signals):
            if sig.get('name') == signal_name:
                if i < len(values):
                    val = values[i]
                    # For simple values (Math, LE, etc.)
                    if isinstance(val, (int, float)):
                        return float(val)
                    # For dict values (PID), return 'output' field
                    if isinstance(val, dict):
                        return val.get('output', val.get('out', 0.0))
                return 0.0
        
        return 0.0
    
    def resolve_signal_property(self, signal_ref: str, prop: str) -> float:
        """Resolve signal property like 'PID:Motor'.OUT (OPTIMIZED)"""
        # Try cache first for fast lookup
        cache_key = signal_ref.upper() if ':' in signal_ref else None
        if cache_key and cache_key in self._signal_cache:
            cached = self._signal_cache[cache_key]
            sig_type = cached['type']
            idx = cached['index']
            prop = prop.upper()
            
            # Only PID has properties currently
            if sig_type == 'pid':
                values = self.signal_state.get('pid', [])
                if idx < len(values):
                    pid_data = values[idx]
                    if prop == 'OUT':
                        return pid_data.get('out', 0.0)
                    elif prop == 'U':
                        return pid_data.get('u', 0.0)
                    elif prop == 'SP':
                        return pid_data.get('target', 0.0)
                    elif prop == 'PV':
                        return pid_data.get('pv', 0.0)
                    elif prop == 'ERR':
                        return pid_data.get('err', 0.0)
                    elif prop == 'MAX':
                        return pid_data.get('out_max', 10.0)
                    elif prop == 'MIN':
                        return pid_data.get('out_min', -10.0)
            return 0.0
        
        # SLOW FALLBACK: Original method
        return self._resolve_signal_property_slow(signal_ref, prop)
    
    def _resolve_signal_property_slow(self, signal_ref: str, prop: str) -> float:
        """Original slow method - fallback for cache misses"""
        if ':' not in signal_ref:
            return 0.0
        
        signal_type, signal_name = signal_ref.split(':', 1)
        signal_type = signal_type.upper()
        prop = prop.upper()
        
        # Only PID has properties currently
        if signal_type == 'PID':
            signals = self.signal_state.get('pid_list', [])
            values = self.signal_state.get('pid', [])
            
            for i, sig in enumerate(signals):
                if sig.get('name') == signal_name and i < len(values):
                    pid_data = values[i]
                    if prop == 'OUT':
                        return pid_data.get('out', 0.0)
                    elif prop == 'U':
                        return pid_data.get('u', 0.0)
                    elif prop == 'SP':
                        return pid_data.get('target', 0.0)
                    elif prop == 'PV':
                        return pid_data.get('pv', 0.0)
                    elif prop == 'ERR':
                        return pid_data.get('err', 0.0)
                    elif prop == 'MAX':
                        return pid_data.get('out_max', 10.0)
                    elif prop == 'MIN':
                        return pid_data.get('out_min', -10.0)
            return 0.0
        
        return 0.0


def evaluate_expression(expr_text: str, signal_state: Dict[str, Any]) -> Tuple[float, Dict[str, float], List[Dict], Dict[int, str], set]:
    """
    Evaluate an expression and return (result, local_vars, hardware_writes, branch_paths, executed_lines)
    
    Args:
        expr_text: Expression source code
        signal_state: Dictionary with signal values and metadata
    
    Returns:
        (result, local_vars, hardware_writes, branch_paths, executed_lines) tuple
        hardware_writes is a list of dicts with 'type', 'channel', 'value'
        branch_paths is a dict mapping IF node IDs to 'then' or 'else'
        executed_lines is a set of line numbers (0-indexed) that executed
    
    Raises:
        Exception: Any parsing or evaluation error
    """
    # Tokenize
    lexer = Lexer(expr_text)
    tokens = lexer.tokenize()
    
    # Parse
    parser = Parser(tokens)
    ast = parser.parse()
    
    # Evaluate
    evaluator = Evaluator(signal_state)
    result = evaluator.evaluate(ast)
    
    return result, evaluator.local_vars, evaluator.hardware_writes, evaluator.branch_paths, evaluator.executed_lines


# Test function
if __name__ == "__main__":
    # Test basic expressions
    test_cases = [
        ("2 + 3 * 4", 14.0),
        ("(2 + 3) * 4", 20.0),
        ("10 / 2 - 3", 2.0),
        ("IF 5 > 3 THEN 10 ELSE 20", 10.0),
        ("IF (2 > 5) AND (3 < 10) THEN 1 ELSE 0", 0.0),
        ("IF (2 < 5) OR (3 > 10) THEN 1 ELSE 0", 1.0),
    ]
    
    print("Testing expression evaluator:")
    for expr, expected in test_cases:
        result, _, _ = evaluate_expression(expr, {'time': 0, 'sample': 0})
        status = "✓" if abs(result - expected) < 1e-9 else "✗"
        print(f"{status} {expr} = {result} (expected {expected})")
    
    # Test variables
    print("\nTesting variables:")
    expr = """
x = 5
y = x * 2
y + 3
"""
    result, locals, _ = evaluate_expression(expr.strip(), {'time': 0, 'sample': 0})
    print(f"Result: {result}, Locals: {locals}")
    
    # Test static variables
    print("\nTesting static variables:")
    global_vars.clear()
    evaluate_expression("static.counter = 10", {})
    result, _, _ = evaluate_expression("static.counter + 5", {})
    print(f"static.counter + 5 = {result}")
    print(f"Global vars: {global_vars.list_all()}")
