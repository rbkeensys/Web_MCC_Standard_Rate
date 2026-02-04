# Expression Language Reference Guide

**Version 1.2** | MCC DAQ System | Expression Engine Documentation  
**Updated:** January 2026 - Added ENDIF requirement, nested IF examples, Math/Expr as PID inputs, enable gates

---

**⚠️ IMPORTANT: Multi-Line IF Statements Require ENDIF**

As of version 1.2, all multi-statement IF blocks must end with `ENDIF`:
- **Inline IFs** (single expression): `alarm = IF temp > 500 THEN 1 ELSE 0` ← No ENDIF needed
- **Block IFs** (multiple statements): Must end with `ENDIF`

Example:
```javascript
IF waterLevel < 40 THEN
    "DO:Pump" = 1
    static.pumpFlow = 0.15
ELSE
    "DO:Pump" = 0
    static.pumpFlow = 0
ENDIF
```

---

## Table of Contents

1. [Overview](#overview)
2. [Basic Syntax](#basic-syntax)
3. [Signal References](#signal-references)
4. [Signal Properties](#signal-properties)
5. [Operators](#operators)
6. [Control Flow](#control-flow)
7. [Variables](#variables)
8. [Hardware Outputs](#hardware-outputs)
9. [Built-in Functions](#built-in-functions)
10. [Advanced Integration](#advanced-integration)
11. [Complete Examples](#complete-examples)
12. [Best Practices](#best-practices)

---

## Overview

The Expression Engine allows you to create custom calculations, logic, and automation using real-time sensor data and control outputs. Expressions can read from any signal in the system, perform calculations, make decisions, and control hardware outputs.

**Key Features:**
- Access all system signals (AI, AO, TC, DO, PID, Math, Logic Elements)
- Read signal properties (PID setpoints, output limits, etc.)
- Mathematical operations and functions
- Conditional logic (IF/THEN/ELSE)
- Boolean operations (AND, OR, NOT)
- Hardware control (set DO and AO outputs)
- Persistent variables (maintain state between evaluations)

---

## Basic Syntax

### Comments
```javascript
// This is a single-line comment
x = 5  // Comments can appear after code
```

### Assignments
```javascript
variable = expression
result = 2 + 3
temperature = "AI:Temp1"
```

### Multiple Statements
```javascript
x = 5
y = 10
z = x + y
z  // Last value is the output
```

### Whitespace
Whitespace is flexible - use it for readability:
```javascript
x=5        // Compact
x = 5      // Spaced (recommended)
x    =   5 // Extra spaces OK
```

---

## Signal References

All signals are referenced using quoted strings in the format `"TYPE:Name"` where:
- **TYPE** is the signal type (AI, AO, TC, DO, PID, Math, LE, Expr)
- **Name** is the signal's configured name

### Analog Inputs (AI)

**Syntax:** `"AI:SignalName"`

Access analog input channels by their configured names.

**Examples:**
```javascript
// Read by name
pressure = "AI:Pressure"
temperature = "AI:Temperature"
flow = "AI:DP Flow 1"

// Use in calculations
pressurePSI = "AI:Pressure" * 14.5038

// Compare values
highPressure = "AI:Pressure" > 100
```

**Notes:**
- AI values are already scaled according to channel configuration (slope and offset)
- AI values include low-pass filtering if configured
- Names are case-sensitive and must match exactly

---

### Analog Outputs (AO)

**Syntax:** `"AO:SignalName"`

Read the current voltage on analog output channels.

**Examples:**
```javascript
// Read current AO value
heaterVoltage = "AO:Heater Control"
valvePosition = "AO:Valve Position"

// Use in feedback calculations
error = targetVoltage - "AO:Output1"
```

**Notes:**
- Returns the last commanded voltage (0-10V typically)
- Useful for feedback or monitoring what was last commanded

---

### Thermocouples (TC)

**Syntax:** `"TC:SignalName"`

Access thermocouple temperature readings.

**Examples:**
```javascript
// Read temperature
furnaceTemp = "TC:Furnace"
ambientTemp = "TC:Ambient"

// Calculate average
avgTemp = ("TC:Zone1" + "TC:Zone2") / 2

// Temperature control logic
IF "TC:Furnace" > 500 THEN
    shutdown = 1
```

**Notes:**
- Values are in the configured temperature unit (typically °C or °F)
- TC values include offset correction and filtering if configured
- Update rate is typically slower than AI (10 Hz max)

---

### Digital Outputs (DO)

**Syntax:** `"DO:SignalName"`

Read the current state of digital output channels.

**Examples:**
```javascript
// Read DO state
pumpRunning = "DO:Pump"
alarmActive = "DO:Alarm"

// Use in logic
safeToStart = NOT "DO:EmergencyStop"
```

**Notes:**
- Returns 1 (ON/true) or 0 (OFF/false)
- Accounts for active-high vs active-low configuration
- Useful for interlocks and state machines

---

### PID Controllers (PID)

**Syntax:** `"PID:LoopName"`

Access PID controller outputs and internal states.

**Examples:**
```javascript
// Read PID output
motorSpeed = "PID:Speed Controller"
heaterPower = "PID:Temperature Loop"

// Use PID output in calculations
totalPower = "PID:Loop1" + "PID:Loop2"
```

**Available Properties:**
- **Default (no property):** PID output value (`u`)
- **`.PV`** - Process variable (current sensor value)
- **`.SP`** - Setpoint (target value)
- **`.ERR`** - Error (SP - PV)
- **`.OUT`** - Output value (same as default)
- **`.MIN`** - Output minimum clamp value
- **`.MAX`** - Output maximum clamp value

**Property Examples:**
```javascript
// Read different PID values
currentTemp = "PID:Temp Control".PV
targetTemp = "PID:Temp Control".SP
tempError = "PID:Temp Control".ERR
controlOutput = "PID:Temp Control".OUT

// Use in calculations
percentOfMax = "PID:Motor".OUT / "PID:Motor".MAX * 100

// Check if at setpoint
atTarget = ABS("PID:Heater".ERR) < 5
```

---

### Math Operators (Math)

**Syntax:** `"Math:OperatorName"`

Access outputs from Math Operator elements.

**Examples:**
```javascript
// Read math operator result
scaledPressure = "Math:Pressure Conversion"
filteredSignal = "Math:LPF Signal"

// Use in further calculations
ratio = "Math:Flow A" / "Math:Flow B"

// Chain operations
result = "Math:Step1" * 2 + "Math:Step2"
```

**Notes:**
- Math operators evaluate before expressions
- Useful for complex calculations split into steps
- Can include filtering, scaling, and multi-input operations

---

### Logic Elements (LE)

**Syntax:** `"LE:ElementName"`

Access outputs from Logic Element blocks.

**Examples:**
```javascript
// Read logic element output
systemReady = "LE:All Systems Go"
emergencyStop = "LE:E-Stop Condition"

// Use in conditional logic
IF "LE:Safety OK" THEN
    enablePump = 1
ELSE
ENDIF
    enablePump = 0

// Combine logic elements
canStart = "LE:Pressure OK" AND "LE:Temp OK"
```

**Notes:**
- Returns 1 (true) or 0 (false)
- Logic elements evaluate before expressions (after Math)
- Useful for complex boolean conditions

---

### Other Expressions (Expr)

**Syntax:** `"Expr:ExpressionName"`

Reference outputs from other expressions (if they evaluate before this one).

**Examples:**
```javascript
// Use result from Expression 0
baseCalc = "Expr:Base Calculation"
adjusted = baseCalc * 1.1

// Chain expressions
step1 = "Expr:Conversion"
step2 = step1 + 10
step3 = step2 * 2
```

**Notes:**
- Expressions evaluate in order (0, 1, 2, ...)
- Can only reference expressions with lower index numbers
- Useful for breaking complex logic into steps

---

## Signal Properties

Some signal types have additional properties accessible with dot notation.

### PID Properties

```javascript
"PID:LoopName".PV    // Process Variable (current sensor reading)
"PID:LoopName".SP    // Setpoint (target value)
"PID:LoopName".ERR   // Error (setpoint - process variable)
"PID:LoopName".OUT   // Output value (control signal)
"PID:LoopName".MIN   // Minimum output clamp
"PID:LoopName".MAX   // Maximum output clamp
```

**Example Use Cases:**

**Monitor PID Performance:**
```javascript
// Check if PID is saturated
saturated = ("PID:Motor".OUT >= "PID:Motor".MAX) OR 
            ("PID:Motor".OUT <= "PID:Motor".MIN)

// Calculate control effort
effort = ABS("PID:Heater".OUT) / "PID:Heater".MAX * 100
```

**Setpoint Tracking:**
```javascript
// Check if close to setpoint
atSetpoint = ABS("PID:Temp".ERR) < 2.0

// Deviation from target
deviation = "PID:Pressure".SP - "PID:Pressure".PV
```

**Dynamic Limits:**
```javascript
// Use PID limits in calculations
safeRange = "PID:Valve".MAX - "PID:Valve".MIN
midpoint = ("PID:Valve".MIN + "PID:Valve".MAX) / 2
```

---

## Operators

### Arithmetic Operators

| Operator | Operation | Example | Result |
|----------|-----------|---------|--------|
| `+` | Addition | `5 + 3` | `8` |
| `-` | Subtraction | `10 - 4` | `6` |
| `*` | Multiplication | `6 * 7` | `42` |
| `/` | Division | `20 / 4` | `5` |
| `%` | Modulo (remainder) | `17 % 5` | `2` |
| `^` | Exponentiation | `2 ^ 3` | `8` |

**Examples:**
```javascript
// Basic math
total = price * quantity
average = (a + b + c) / 3
remainder = count % 10
squared = value ^ 2

// Order of operations (standard)
result = 2 + 3 * 4      // = 14 (multiply first)
result = (2 + 3) * 4    // = 20 (parentheses first)
```

### Comparison Operators

| Operator | Comparison | Example | Result |
|----------|------------|---------|--------|
| `==` | Equal to | `5 == 5` | `1` (true) |
| `!=` | Not equal to | `5 != 3` | `1` (true) |
| `<` | Less than | `3 < 5` | `1` (true) |
| `<=` | Less than or equal | `5 <= 5` | `1` (true) |
| `>` | Greater than | `7 > 5` | `1` (true) |
| `>=` | Greater than or equal | `5 >= 5` | `1` (true) |

**Examples:**
```javascript
// Temperature threshold
overTemp = "TC:Furnace" > 500

// Pressure in range
pressureOK = ("AI:Pressure" >= 20) AND ("AI:Pressure" <= 80)

// Equality check
motorAtSpeed = ABS("PID:Motor".PV - "PID:Motor".SP) < 1
```

### Boolean Operators

| Operator | Operation | Example | Result |
|----------|-----------|---------|--------|
| `AND` | Logical AND | `1 AND 1` | `1` (true) |
| `OR` | Logical OR | `1 OR 0` | `1` (true) |
| `NOT` | Logical NOT | `NOT 0` | `1` (true) |

**Truth Tables:**

**AND:**
```
A | B | A AND B
0 | 0 | 0
0 | 1 | 0
1 | 0 | 0
1 | 1 | 1
```

**OR:**
```
A | B | A OR B
0 | 0 | 0
0 | 1 | 1
1 | 0 | 1
1 | 1 | 1
```

**NOT:**
```
A | NOT A
0 | 1
1 | 0
```

**Examples:**
```javascript
// All conditions must be true
allOK = tempOK AND pressureOK AND flowOK

// Any condition triggers alarm
alarm = overTemp OR overPressure OR lowFlow

// Invert signal
stopped = NOT running

// Complex logic
safeToOperate = (tempOK AND pressureOK) AND (NOT emergencyStop)
```

---

## Control Flow

### IF Statements

IF statements support two styles: **inline** (single-expression) and **block** (multi-line).

#### Inline Style (No ENDIF Required)

For simple single-expression IFs, no ENDIF is needed:

**Basic Syntax:**
```javascript
IF condition THEN value
IF condition THEN value1 ELSE value2
```

**Examples:**
```javascript
// Set 1 if temp high, 0 otherwise
alarm = IF "TC:Temp" > 500 THEN 1 ELSE 0

// Select value based on condition
setpoint = IF mode == 1 THEN 350 ELSE 250

// Clamp value
limited = IF value > 100 THEN 100 ELSE value

// Choose signal source
signal = IF useBackup THEN "AI:Backup" ELSE "AI:Primary"
```

#### Block Style (ENDIF Required)

For multi-statement IFs, **ENDIF is required** to mark the end of the block:

**Basic Syntax:**
```javascript
IF condition THEN
    statement1
    statement2
    ...
ENDIF

IF condition THEN
    statement1
    statement2
ELSE
ENDIF
    statement3
    statement4
ENDIF
```

**Multi-Statement Example:**
```javascript
temp = "TC:Furnace"

IF temp > 500 THEN
    heaterPower = 0
    "DO:Alarm" = 1
    static.overTempCount = static.overTempCount + 1
ELSE
ENDIF
    heaterPower = 100
    "DO:Alarm" = 0
ENDIF
```

**Why ENDIF?** Without ENDIF, the parser can't tell where the IF block ends:
```javascript
// ❌ AMBIGUOUS - Where does IF end?
IF temp > 500 THEN
    heaterPower = 0
    "DO:Alarm" = 1

nextStatement = 1  // Is this part of the IF?

// ✅ CLEAR - ENDIF marks the boundary
IF temp > 500 THEN
    heaterPower = 0
    "DO:Alarm" = 1
ENDIF

nextStatement = 1  // Clearly not part of IF
```

### Nested IF Statements

IF statements can be nested to create complex decision trees. Each IF can have only ONE ELSE clause, but that ELSE can contain another IF.

**ELSE-IF Chain (Recommended for Multiple Conditions):**
```javascript
// Check multiple conditions in sequence
temp = "TC:Furnace"

IF temp < 100 THEN
    status = 0    // Too cold
ELSE IF temp < 200 THEN
    status = 1    // Warming
ELSE IF temp < 400 THEN
    status = 2    // Normal operating range
ELSE IF temp < 500 THEN
    status = 3    // Getting hot
ELSE
ENDIF
    status = 4    // Too hot - emergency
ENDIF

status
```

**Deeply Nested Conditions:**
```javascript
// Tank level control with pressure checking
level = "AI:Tank Level"
pressure = "AI:Pressure"

IF level < 20 THEN
    // Critical low level
    "DO:Pump" = 0
    "DO:Alarm" = 1
    static.pumpFlow = 0
ELSE IF level < 40 THEN
    // Low level - start filling slowly
    "DO:Pump" = 1
    "DO:Alarm" = 0
    static.pumpFlow = 0.15
ELSE IF level < 80 THEN
    // Normal range - check pressure
    IF pressure < 50 THEN
        // Low pressure - fill faster
        "DO:Pump" = 1
        static.pumpFlow = 0.50
    ELSE IF pressure < 80 THEN
        // Normal pressure - moderate fill
        "DO:Pump" = 1
        static.pumpFlow = 0.30
    ELSE
ENDIF
        // High pressure - stop filling
        "DO:Pump" = 0
        static.pumpFlow = 0
    ENDIF
    "DO:Alarm" = 0
ELSE
ENDIF
    // Tank full - stop everything
    "DO:Pump" = 0
    "DO:Alarm" = 0
    static.pumpFlow = 0
ENDIF

level
```

**Multi-Sensor Logic:**
```javascript
// Complex safety interlock with nested conditions
temp = "TC:Reactor"
pressure = "AI:Pressure"
flow = "AI:Coolant Flow"
emergencyStop = "DO:E-Stop"

IF emergencyStop THEN
    // Emergency stop overrides everything
    "DO:Heater" = 0
    "DO:Pump" = 0
    safeToRun = 0
ELSE
ENDIF
    // Check all safety conditions
    IF temp > 600 THEN
        // Over-temperature
        IF pressure > 100 THEN
            // Both high - full shutdown
            "DO:Heater" = 0
            "DO:Pump" = 0
            "DO:Vent" = 1
            safeToRun = 0
        ELSE
ENDIF
            // Just temp high - cool down
            "DO:Heater" = 0
            "DO:Pump" = 1
            safeToRun = 0
        ENDIF
    ELSE IF pressure > 100 THEN
        // Just pressure high - vent
        "DO:Heater" = 0
        "DO:Vent" = 1
        safeToRun = 0
    ELSE IF flow < 5 THEN
        // Low coolant flow - unsafe
        "DO:Heater" = 0
        safeToRun = 0
    ELSE
ENDIF
        // All conditions OK
        safeToRun = 1
    ENDIF
ENDIF

safeToRun
```

**State Machine with Nested Logic:**
```javascript
// Batch process state machine
static.state = static.state || 0
level = "AI:Tank Level"
temp = "TC:Tank"

// State 0: Idle
IF static.state == 0 THEN
    IF "DO:Start Button" THEN
        IF level < 10 THEN
            // Too low to start
            static.state = 0
            "DO:Error Light" = 1
        ELSE
ENDIF
            // OK to start
            static.state = 1
            "DO:Error Light" = 0
        ENDIF
    ENDIF
ENDIF

// State 1: Filling
IF static.state == 1 THEN
    "DO:Fill Valve" = 1
    IF level > 80 THEN
        static.state = 2
        "DO:Fill Valve" = 0
    ENDIF
ENDIF

// State 2: Heating
IF static.state == 2 THEN
    IF temp < 350 THEN
        "DO:Heater" = 1
    ELSE
ENDIF
        "DO:Heater" = 0
        IF temp > 355 THEN
            // Reached temperature + buffer
            static.state = 3
            static.holdTimer = 0
        ENDIF
    ENDIF
ENDIF

// State 3: Holding at temperature
IF static.state == 3 THEN
    // Maintain temperature
    IF temp < 345 THEN
        "DO:Heater" = 1
    ELSE IF temp > 355 THEN
        "DO:Heater" = 0
    ENDIF
    
    // Count time
    static.holdTimer = static.holdTimer + 0.01
    
    IF static.holdTimer > 300 THEN
        // 5 minutes elapsed
        static.state = 4
    ENDIF
ENDIF

// State 4: Cooling and draining
IF static.state == 4 THEN
    "DO:Heater" = 0
    IF temp < 200 THEN
        "DO:Drain Valve" = 1
        IF level < 10 THEN
            "DO:Drain Valve" = 0
            static.state = 0
        ENDIF
    ENDIF
ENDIF

static.state
```

### Important Rules for IFs

1. **Multi-line IF blocks require ENDIF** - Single statement inline IFs don't need ENDIF
   ```javascript
   // ✅ Inline - no ENDIF needed
   alarm = IF temp > 500 THEN 1 ELSE 0
   
   // ✅ Block - ENDIF required
   IF temp > 500 THEN
       alarm = 1
       "DO:Heater" = 0
   ENDIF
   ```

2. **Each IF has ONE ELSE** - You cannot have multiple ELSE clauses for the same IF
   ```javascript
   // ❌ WRONG - Two ELSE clauses
   IF condition1 THEN
       value1
   ELSE
ENDIF
       value2
   ELSE  // ERROR!
       value3
   
   // ✅ CORRECT - Use ELSE IF
   IF condition1 THEN
       value1
   ELSE IF condition2 THEN
       value2
   ELSE
ENDIF
       value3
   ```

2. **ELSE IF is your friend** - For sequential checks, use ELSE IF chains instead of deep nesting

3. **Only the last value matters** - In a multi-statement block, the last expression's value is returned

4. **Indent for readability** - Makes nested logic much easier to understand

---

## Variables

### Local Variables

Local variables exist only during the current evaluation and are reset each cycle.

**Syntax:**
```javascript
variableName = value
```

**Examples:**
```javascript
// Intermediate calculations
temp = "TC:Furnace"
pressure = "AI:Pressure"
scaledTemp = temp * 1.8 + 32
scaledPressure = pressure * 14.5038
ratio = scaledTemp / scaledPressure

// Readability
sensorA = "AI:Sensor A"
sensorB = "AI:Sensor B"
average = (sensorA + sensorB) / 2
difference = sensorA - sensorB
```

### Static Variables

Static variables persist between evaluations, maintaining their value across cycles.

**Syntax:**
```javascript
static.variableName = value
```

**Default Values:**
```javascript
// Initialize if doesn't exist
static.counter = static.counter || 0
```

**Examples:**

**Counter:**
```javascript
// Increment counter each cycle
static.count = static.count || 0
static.count = static.count + 1
static.count
```

**State Machine:**
```javascript
// Initialize state
static.state = static.state || 0

// State transitions
IF static.state == 0 AND startButton THEN
    static.state = 1

IF static.state == 1 AND processComplete THEN
    static.state = 2

IF static.state == 2 AND resetButton THEN
    static.state = 0

static.state  // Output current state
```

**Accumulator:**
```javascript
// Running total
static.total = static.total || 0
static.total = static.total + "AI:Flow" * 0.01  // Add flow
static.total
```

**Latch:**
```javascript
// Set and hold
static.alarm = static.alarm || 0

// Set on condition
IF "TC:Temp" > 500 THEN
    static.alarm = 1

// Reset on button
IF resetButton THEN
    static.alarm = 0

static.alarm
```

### Global Variables

Global variables persist across all expressions and system restarts (saved to disk).

**Syntax:**
```javascript
global.variableName = value
```

**Examples:**

**Calibration Offset:**
```javascript
// Set once, use everywhere
global.pressureOffset = global.pressureOffset || 0
correctedPressure = "AI:Pressure" + global.pressureOffset
```

**Operating Hours:**
```javascript
// Track total runtime
global.runHours = global.runHours || 0
IF "DO:Motor Running" THEN
    global.runHours = global.runHours + (1.0 / 3600.0)  // Add 1 second
global.runHours
```

**Production Count:**
```javascript
// Count parts produced
global.partCount = global.partCount || 0
IF partDetected AND NOT partWasDetected THEN
    global.partCount = global.partCount + 1
partWasDetected = partDetected
global.partCount
```

---

## Hardware Outputs

Expressions can directly control hardware outputs using assignment syntax.

### Digital Outputs (DO)

**Syntax:**
```javascript
"DO:OutputName" = value
```

**Value Interpretation:**
- `>= 1.0` → ON (true)
- `< 1.0` → OFF (false)

**Examples:**

**Simple Control:**
```javascript
// Turn on pump if pressure low
IF "AI:Pressure" < 50 THEN
    "DO:Pump" = 1
ELSE
ENDIF
    "DO:Pump" = 0
```

**Boolean Expression:**
```javascript
// Direct boolean result
"DO:Heater" = "TC:Temp" < 350
```

**Interlock:**
```javascript
// Enable only if all conditions met
safeToRun = tempOK AND pressureOK AND NOT emergencyStop
"DO:Motor Enable" = safeToRun
```

**Multiple Outputs:**
```javascript
// Coordinated control
IF pressure > 80 THEN
    "DO:Vent Valve" = 1
    "DO:Alarm" = 1
ELSE
ENDIF
    "DO:Vent Valve" = 0
    "DO:Alarm" = 0
```

### Analog Outputs (AO)

**Syntax:**
```javascript
"AO:OutputName" = voltage
```

**Value Range:**
- Typically 0-10V (hardware dependent)
- Clipped to valid range automatically

**Examples:**

**Proportional Control:**
```javascript
// Scale 0-100 to 0-10V
percentage = 75
voltage = percentage / 10.0
"AO:Valve Position" = voltage
```

**Feedback Control:**
```javascript
// Manual control output
target = 500
current = "TC:Temp"
error = target - current
output = error * 0.02  // Proportional gain
"AO:Heater" = output
```

**Ramping:**
```javascript
// Ramp output slowly
static.ramp = static.ramp || 0
target = 8.0
rampRate = 0.1  // V/s
dt = 0.01       // 100 Hz sample rate

IF static.ramp < target THEN
    static.ramp = static.ramp + rampRate * dt
ELSE IF static.ramp > target THEN
    static.ramp = static.ramp - rampRate * dt

"AO:Output1" = static.ramp
```

---

## Built-in Functions

### Mathematical Functions

**ABS(x)** - Absolute value
```javascript
distance = ABS(setpoint - current)
magnitude = ABS(voltage)
```

**SQRT(x)** - Square root
```javascript
rms = SQRT((a^2 + b^2 + c^2) / 3)
stdDev = SQRT(variance)
```

**MIN(a, b)** - Minimum of two values
```javascript
lower = MIN(sensor1, sensor2)
clamped = MIN(value, 100)
```

**MAX(a, b)** - Maximum of two values
```javascript
higher = MAX(sensor1, sensor2)
atLeast = MAX(value, 0)
```

**CLAMP(value, min, max)** - Constrain value to range
```javascript
limited = CLAMP(input, 0, 100)
voltage = CLAMP(computed, 0, 10)
```

### Trigonometric Functions

**SIN(x)**, **COS(x)**, **TAN(x)** - Basic trig (x in radians)
```javascript
wave = SIN(time * 2 * 3.14159)
phase = COS(angle)
```

**ASIN(x)**, **ACOS(x)**, **ATAN(x)** - Inverse trig
```javascript
angle = ASIN(ratio)
```

**ATAN2(y, x)** - Two-argument arctangent
```javascript
angle = ATAN2(yComponent, xComponent)
```

### Exponential Functions

**EXP(x)** - e^x
```javascript
growth = EXP(rate * time)
```

**LOG(x)** - Natural logarithm (ln)
```javascript
decay = LOG(concentration)
```

**LOG10(x)** - Base-10 logarithm
```javascript
decibels = 20 * LOG10(amplitude)
pH = -LOG10(concentration)
```

**POW(base, exponent)** - Power function
```javascript
area = POW(radius, 2) * 3.14159
volume = POW(side, 3)
```

---

## Advanced Integration

### Using Expressions with Other System Components

Expressions integrate deeply with the entire system. Your expression outputs can control PIDs, trigger logic, and be used as inputs anywhere in the system.

### Math Operators as Inputs

Math operators can preprocess signals before they're used in expressions. This is useful for filtering, scaling, or complex calculations that are easier to configure in the Math Operator UI.

**Example: Using Filtered Signal**
```javascript
// Math Operator 0: Low-pass filter
//   Operation: ewma
//   Input: AI:Noisy Sensor
//   Alpha: 0.1
//   Result: Smoothed signal

// Expression: Use filtered value
filteredSignal = "Math:Smoothed Pressure"

IF filteredSignal > 100 THEN
    "DO:Alarm" = 1
ELSE
ENDIF
    "DO:Alarm" = 0

filteredSignal
```

**Example: Scaled and Offset Signal**
```javascript
// Math Operator 0: Scale and offset
//   Operation: scale_offset
//   Input: AI:Raw Sensor
//   Scale: 14.5038
//   Offset: 0
//   Result: PSI value

// Expression: Use converted value
pressurePSI = "Math:Pressure PSI"
targetPSI = 65

error = targetPSI - pressurePSI
error
```

### Expressions as PID Inputs

**NEW FEATURE:** PIDs can now use Math operators and Expressions as inputs for:
- Process Variable (PV)
- Setpoint (SP)
- Output clamps (min/max)
- Enable gates

**Example: Expression-Driven PID Setpoint**
```javascript
// Expression: Dynamic setpoint based on load
load = "AI:System Load"

IF load > 80 THEN
    static.targetTemp = 300    // High load - lower temp
ELSE IF load > 50 THEN
    static.targetTemp = 350    // Medium load
ELSE
ENDIF
    static.targetTemp = 400    // Low load - higher temp

static.targetTemp
```

Then configure PID:
```
PID Configuration:
  Process Variable: TC:Reactor
  Setpoint Source: expr
  Setpoint Index: 0 (Dynamic Setpoint)
  → PID will track the expression's output as setpoint
```

**Example: Computed Process Variable**
```javascript
// Expression: Average of three sensors for redundancy
sensor1 = "AI:Temp Sensor 1"
sensor2 = "AI:Temp Sensor 2"
sensor3 = "AI:Temp Sensor 3"

// Use median instead of average for fault tolerance
temps = [sensor1, sensor2, sensor3]
avgTemp = (sensor1 + sensor2 + sensor3) / 3

avgTemp
```

Then configure PID:
```
PID Configuration:
  Source: expr
  Source Index: 0 (Average Temperature)
  Setpoint Source: fixed
  Setpoint: 350
  → PID uses averaged sensor reading
```

### Expressions as Enable Gates

Expressions can enable/disable PIDs and analog outputs based on complex conditions.

**Example: Multi-Condition Safety Gate**
```javascript
// Expression: System ready check
temp = "TC:Furnace"
pressure = "AI:Pressure"
flow = "AI:Coolant Flow"
manualOverride = "DO:Override Switch"

// All conditions must be met
tempOK = (temp > 100) AND (temp < 600)
pressureOK = (pressure > 20) AND (pressure < 100)
flowOK = flow > 5

// Output 1 if safe to run, 0 if not
IF manualOverride THEN
    1  // Override enabled - allow operation
ELSE IF tempOK AND pressureOK AND flowOK THEN
    1  // All conditions OK
ELSE
ENDIF
    0  // Not safe
```

Then configure PID:
```
PID Configuration:
  Name: Heater Control
  Enable Gate: ✓
  Gate Type: expr
  Gate Index: 0 (System Ready Check)
  → PID only runs when expression outputs >= 1.0
```

**How Gates Work:**
- Value >= 1.0 → PID enabled
- Value < 1.0 → PID disabled (output forced to 0, integrator reset)

### Chaining Expressions

Expressions can reference other expressions (that evaluated before them). This allows breaking complex logic into manageable pieces.

**Example: Multi-Stage Processing**
```javascript
// Expression 0: Sensor conditioning
raw = "AI:Flow Sensor"
static.offset = static.offset || 0
conditioned = raw - static.offset
conditioned

// Expression 1: Flow calculation
deltaP = "Expr:Sensor Conditioning"  // Use expr 0 output
flowCoeff = 32.28
flow = flowCoeff * SQRT(deltaP)
flow

// Expression 2: Flow totalizer
static.total = static.total || 0
currentFlow = "Expr:Flow Rate"  // Use expr 1 output
static.total = static.total + currentFlow * 0.01  // Integrate
static.total
```

**Benefits of Chaining:**
- ✅ Easier to debug (check each stage)
- ✅ Reusable components
- ✅ Clearer logic flow
- ✅ Can view intermediate values

### Global Variables for System-Wide State

Global variables (static.*) persist across all system restarts and can be shared between expressions.

**Example: Shared Configuration**
```javascript
// Expression 0: Configuration variables
static.highTempLimit = static.highTempLimit || 500
static.lowTempLimit = static.lowTempLimit || 100
static.pressureLimit = static.pressureLimit || 80

1  // Always returns 1

// Expression 1: Use shared config
temp = "TC:Furnace"
tempAlarm = (temp > static.highTempLimit) OR (temp < static.lowTempLimit)

IF tempAlarm THEN 1 ELSE 0

// Expression 2: Also uses shared config
pressure = "AI:Pressure"
pressureAlarm = pressure > static.pressureLimit

IF pressureAlarm THEN 1 ELSE 0
```

**Benefits:**
- Change limit in one place, affects all expressions
- Persistent across restarts
- Can be modified from any expression

### Logic Elements with Expression Inputs

Logic Elements can use expressions as inputs for their comparisons.

**Example: Expression Output as LE Input**
```javascript
// Expression: Calculate efficiency
power = "AI:Power"
output = "AI:Output"
efficiency = (output / power) * 100
efficiency

// Logic Element:
//   Input A: expr:0 (efficiency)
//   Compare: greater_than
//   Input B: value (75)
//   → Triggers when efficiency > 75%
```

### Complete Integration Example

**Scenario:** Batch reactor with expression-based state machine controlling PIDs

```javascript
// Expression 0: State Machine
static.state = static.state || 0
static.timer = static.timer || 0

level = "AI:Tank Level"
temp = "TC:Reactor"

// State transitions
IF static.state == 0 AND "DO:Start" THEN
    static.state = 1
    static.timer = 0

IF static.state == 1 AND level > 80 THEN
    static.state = 2
    static.timer = 0

IF static.state == 2 AND temp > 350 THEN
    static.state = 3
    static.timer = 0

IF static.state == 3 THEN
    static.timer = static.timer + 0.01
    IF static.timer > 600 THEN
        static.state = 4

IF static.state == 4 AND level < 10 THEN
    static.state = 0

static.state

// Expression 1: Temperature Setpoint
state = "Expr:State Machine"

IF state == 2 THEN
    350  // Heating state
ELSE IF state == 3 THEN
    350  // Hold at temp state
ELSE
ENDIF
    0    // All other states - no heat

// Expression 2: System Enable
state = "Expr:State Machine"

IF state == 0 THEN
    0  // Idle - nothing enabled
ELSE
ENDIF
    1  // Any active state - enable

// PID Configuration:
//   Setpoint Source: expr
//   Setpoint Index: 1 (Temperature Setpoint)
//   Enable Gate: ✓
//   Gate Type: expr
//   Gate Index: 2 (System Enable)
```

This creates a complete automated batch process!

---

## Complete Examples

### Example 1: Temperature Controller with Safety

```javascript
// Read sensors
temp = "TC:Furnace"
pressure = "AI:Pressure"

// Safety checks
tempOK = temp < 600
pressureOK = pressure < 100
emergencyStop = "DO:E-Stop"

// All systems must be OK
safeToOperate = tempOK AND pressureOK AND NOT emergencyStop

// Control heater
IF safeToOperate THEN
    IF temp < 500 THEN
        "DO:Heater" = 1
    ELSE
ENDIF
        "DO:Heater" = 0
ELSE
ENDIF
    "DO:Heater" = 0

// Alarm if unsafe
"DO:Alarm" = NOT safeToOperate

// Output safety status (1 = safe, 0 = unsafe)
safeToOperate
```

### Example 2: Flow Rate Calculator

```javascript
// Orifice plate flow calculation
// Q = K * sqrt(deltaP) where K is flow coefficient

// Read differential pressure
deltaP = "AI:DP Flow 1"

// Flow coefficient (constant for this orifice)
static.flowCoeff = static.flowCoeff || 32.28

// Calculate flow (only if positive pressure)
IF deltaP > 0 THEN
    flow = static.flowCoeff * SQRT(deltaP)
ELSE
ENDIF
    flow = 0

// Store for other expressions to use
static.calculatedFlow = flow

// Output flow rate
flow
```

### Example 3: State Machine for Batch Process

```javascript
// State machine: 0=Idle, 1=Filling, 2=Heating, 3=Holding, 4=Draining

// Initialize
static.state = static.state || 0
static.timer = static.timer || 0

// Read sensors
level = "AI:Tank Level"
temp = "TC:Tank Temp"
startButton = "DO:Start Button"

// State 0: Idle - wait for start
IF static.state == 0 THEN
    IF startButton THEN
        static.state = 1
        static.timer = 0

// State 1: Filling - fill to 80%
IF static.state == 1 THEN
    "DO:Fill Valve" = 1
    IF level > 80 THEN
        static.state = 2
        static.timer = 0
        "DO:Fill Valve" = 0

// State 2: Heating - heat to 350°F
IF static.state == 2 THEN
    "DO:Heater" = 1
    IF temp > 350 THEN
        static.state = 3
        static.timer = 0
        "DO:Heater" = 0

// State 3: Holding - hold for 300 seconds
IF static.state == 3 THEN
    static.timer = static.timer + 0.01  // 100Hz = 0.01s per tick
    IF static.timer > 300 THEN
        static.state = 4
        static.timer = 0

// State 4: Draining - drain to 10%
IF static.state == 4 THEN
    "DO:Drain Valve" = 1
    IF level < 10 THEN
        static.state = 0
        "DO:Drain Valve" = 0

// Output current state
static.state
```

### Example 4: PID Output Limiter Based on Temperature

```javascript
// Limit PID output based on operating temperature
// Higher temp = lower max output for safety

temp = "TC:Reactor"
pidOutput = "PID:Stirrer".OUT

// Calculate maximum allowed output based on temp
// At 200°C: maxOutput = 10
// At 400°C: maxOutput = 5
// Linear interpolation
maxOutput = 10 - (temp - 200) * (5 / 200)
maxOutput = CLAMP(maxOutput, 5, 10)  // Ensure 5-10 range

// Apply to AO (PID output is just a number, we write the actual voltage)
voltage = CLAMP(pidOutput, 0, maxOutput)
"AO:Stirrer Motor" = voltage

// Output the applied voltage for monitoring
voltage
```

### Example 5: Moving Average Filter

```javascript
// 10-point moving average
// Uses static variables as circular buffer

// Initialize buffer
static.buf0 = static.buf0 || 0
static.buf1 = static.buf1 || 0
static.buf2 = static.buf2 || 0
static.buf3 = static.buf3 || 0
static.buf4 = static.buf4 || 0
static.buf5 = static.buf5 || 0
static.buf6 = static.buf6 || 0
static.buf7 = static.buf7 || 0
static.buf8 = static.buf8 || 0
static.buf9 = static.buf9 || 0

// Read new value
newValue = "AI:Noisy Signal"

// Shift buffer
static.buf9 = static.buf8
static.buf8 = static.buf7
static.buf7 = static.buf6
static.buf6 = static.buf5
static.buf5 = static.buf4
static.buf4 = static.buf3
static.buf3 = static.buf2
static.buf2 = static.buf1
static.buf1 = static.buf0
static.buf0 = newValue

// Calculate average
average = (static.buf0 + static.buf1 + static.buf2 + static.buf3 + static.buf4 +
           static.buf5 + static.buf6 + static.buf7 + static.buf8 + static.buf9) / 10

average
```

### Example 6: Production Counter with Reset

```javascript
// Count items produced, with daily reset

// Initialize
global.dailyCount = global.dailyCount || 0
global.lastDay = global.lastDay || 0

// Get current day (assuming time is Unix timestamp)
currentDay = FLOOR(time / 86400)  // Days since epoch

// Reset if new day
IF currentDay != global.lastDay THEN
    global.dailyCount = 0
    global.lastDay = currentDay

// Detect part (rising edge detection)
static.lastSignal = static.lastSignal || 0
partSignal = "DO:Part Sensor"

IF partSignal AND NOT static.lastSignal THEN
    global.dailyCount = global.dailyCount + 1

static.lastSignal = partSignal

// Output count
global.dailyCount
```

---

## Best Practices

### 1. Use Descriptive Variable Names
```javascript
// ❌ Bad
x = "AI:0"
y = x * 2

// ✅ Good
pressure = "AI:Pressure Sensor"
pressurePSI = pressure * 14.5038
```

### 2. Comment Your Code
```javascript
// Calculate volumetric flow from differential pressure
// Using orifice plate equation: Q = K * sqrt(ΔP)
deltaP = "AI:DP Flow 1"
flowCoeff = 32.28  // Calibrated for 2" orifice
flow = flowCoeff * SQRT(deltaP)
```

### 3. Initialize Static Variables
```javascript
// Always provide defaults for static variables
static.counter = static.counter || 0
static.state = static.state || 0
```

### 4. Use Intermediate Variables
```javascript
// ❌ Hard to read
result = ("AI:A" + "AI:B") / 2 * ("TC:C" - "TC:D") + 10

// ✅ Easy to read
avgInput = ("AI:A" + "AI:B") / 2
tempDiff = "TC:C" - "TC:D"
result = avgInput * tempDiff + 10
```

### 5. Validate Signal Names
```javascript
// Use exact names from configuration
// The system will warn about typos during syntax check
pressure = "AI:DP Flow 1"  // Not "AI:DP Flow1" (missing space)
```

### 6. Check Ranges Before Math Operations
```javascript
// ❌ Can fail if pressure is negative
flow = SQRT("AI:DP Pressure")

// ✅ Safe
deltaP = "AI:DP Pressure"
flow = IF deltaP > 0 THEN SQRT(deltaP) ELSE 0
```

### 7. Be Careful with Division
```javascript
// ❌ Division by zero possible
ratio = numerator / denominator

// ✅ Protected
ratio = IF denominator != 0 THEN numerator / denominator ELSE 0
```

### 8. Use Hardware Outputs Judiciously
```javascript
// ❌ May cause rapid switching
"DO:Valve" = pressure > 50

// ✅ Add hysteresis
static.valveState = static.valveState || 0

IF pressure > 55 AND NOT static.valveState THEN
    static.valveState = 1
ELSE IF pressure < 45 AND static.valveState THEN
    static.valveState = 0

"DO:Valve" = static.valveState
```

### 9. Document State Machines
```javascript
// State 0: Idle
// State 1: Starting
// State 2: Running
// State 3: Stopping

static.state = static.state || 0

IF static.state == 0 THEN
    // Idle logic
    ...
```

### 10. Test Incrementally
```javascript
// Build complex expressions in steps
// Test each step before adding more

// Step 1: Just read values
temp = "TC:Furnace"
temp

// Step 2: Add calculation
// temp = "TC:Furnace"
// scaledTemp = temp * 1.8 + 32
// scaledTemp

// Step 3: Add control logic
// ...
```

### 11. Use ELSE IF Instead of Deep Nesting
```javascript
// ❌ Hard to read - deeply nested
IF condition1 THEN
    value1
ELSE
ENDIF
    IF condition2 THEN
        value2
    ELSE
ENDIF
        IF condition3 THEN
            value3
        ELSE
ENDIF
            value4

// ✅ Easy to read - flat chain
IF condition1 THEN
    value1
ELSE IF condition2 THEN
    value2
ELSE IF condition3 THEN
    value3
ELSE
ENDIF
    value4
```

### 12. Leverage Math Operators for Preprocessing
```javascript
// ❌ Doing filtering in expression
static.buf0 = static.buf0 || 0
static.buf1 = static.buf1 || 0
// ... 10 lines of moving average code ...

// ✅ Use Math Operator (EWMA filter)
// Math Op: exponential weighted moving average
filteredValue = "Math:Filtered Signal"
```

**When to use Math Operators vs Expressions:**
- **Math Operators:** Standard operations (filters, scaling, simple math)
- **Expressions:** Complex logic, state machines, multi-signal decisions

### 13. Break Complex Logic into Multiple Expressions
```javascript
// Expression 0: Safety checks
tempOK = "TC:Temp" < 600
pressureOK = "AI:Pressure" < 100
flowOK = "AI:Flow" > 5
IF tempOK AND pressureOK AND flowOK THEN 1 ELSE 0

// Expression 1: Control logic (uses Expression 0)
safetyOK = "Expr:Safety Checks"
IF safetyOK THEN
    "DO:System Enable" = 1
ELSE
ENDIF
    "DO:System Enable" = 0
```

**Benefits:**
- Easier debugging (check each expression separately)
- Can view intermediate results
- Reusable components

### 14. Use Global Variables for System-Wide Settings
```javascript
// Expression 0: Configuration (run once at startup)
static.maxTemp = static.maxTemp || 500
static.minTemp = static.minTemp || 100
static.maxPressure = static.maxPressure || 80
1

// Expression 1-N: Use shared config
alarm = ("TC:Temp" > static.maxTemp) OR ("AI:Pressure" > static.maxPressure)
```

### 15. Indent Nested IFs for Readability
```javascript
// ✅ Clear structure
IF level < 20 THEN
    status = 0
ELSE IF level < 40 THEN
    status = 1
ELSE IF level < 80 THEN
    IF pressure < 50 THEN
        status = 2
    ELSE
ENDIF
        status = 3
ELSE
ENDIF
    status = 4
```

### 16. Name Expressions Descriptively
```
❌ Bad names:
  - Expression 0
  - Test
  - Temp thing

✅ Good names:
  - Safety Interlock
  - Flow Calculation
  - State Machine - Batch Process
  - Dynamic Setpoint Controller
```

### 17. Use Expressions as PID Inputs Strategically
```javascript
// Good use: Dynamic setpoint based on conditions
load = "AI:System Load"
IF load > 80 THEN
    result = 300  // High load - reduce target
ELSE IF load > 50 THEN
    result = 350  // Medium load
ELSE
    result = 400  // Low load - increase target
ENDIF

result

// Then configure PID:
//   Setpoint Source: expr
//   Setpoint Index: 0
```

### 18. Document Integration Points
```javascript
// This expression is used as:
// - PID 0 setpoint
// - PID 1 enable gate
// - Chart 2 signal source

static.masterSetpoint = 350
result = IF "DO:Manual Mode" THEN "AI:Manual Setpoint" ELSE static.masterSetpoint
result
```
// temp = "TC:Furnace"
// scaledTemp = temp * 1.8 + 32
// scaledTemp

// Step 3: Add control logic
// ...
```

---

## Quick Reference Card

### Signal Access
```javascript
"AI:Name"     // Analog input
"AO:Name"     // Analog output
"TC:Name"     // Thermocouple
"DO:Name"     // Digital output
"PID:Name"    // PID controller
"Math:Name"   // Math operator
"LE:Name"     // Logic element
"Expr:Name"   // Other expression
```

### PID Properties
```javascript
"PID:Name".PV    // Process variable
"PID:Name".SP    // Setpoint
"PID:Name".ERR   // Error
"PID:Name".OUT   // Output
"PID:Name".MIN   // Min clamp
"PID:Name".MAX   // Max clamp
```

### Operators
```javascript
+ - * / % ^           // Arithmetic
== != < <= > >=       // Comparison
AND OR NOT            // Boolean
```

### Control Flow
```javascript
// Inline IF (no ENDIF needed)
IF condition THEN value
IF condition THEN value ELSE other
value = IF cond THEN val1 ELSE val2

// Block IF (ENDIF required for multi-statement)
IF cond1 THEN
    statement1
    statement2
ELSE IF cond2 THEN
    statement3
ELSE
    statement4
ENDIF
```

### Variables
```javascript
local = value         // Local (reset each cycle)
static.var = value    // Static (persistent in expression)
global.var = value    // Global (persistent across system)
```

### Hardware Control
```javascript
"DO:Name" = 1         // Set digital output
"AO:Name" = 5.5       // Set analog output voltage
```

### System Integration
```javascript
// Expressions as PID inputs
PID Source: expr, Index: 0
PID Setpoint: expr, Index: 1

// Expressions as enable gates (>= 1.0 = enabled)
PID Enable Gate: expr, Index: 2

// Math operators in expressions
"Math:Filtered Signal"
"Math:Scaled Value"

// Chain expressions
"Expr:Previous Expression"
```

### Common Functions
```javascript
ABS(x)                // Absolute value
SQRT(x)               // Square root
MIN(a,b)  MAX(a,b)    // Min/max
CLAMP(v,min,max)      // Constrain to range
SIN(x) COS(x) TAN(x)  // Trig functions
LOG(x) LOG10(x)       // Logarithms
```

---

## Troubleshooting

### Common Errors

**"Signal not found"**
- Check signal name spelling (case-sensitive)
- Verify signal exists in configuration
- Use syntax checker to see available signals

**"Division by zero"**
- Add check before dividing: `IF denom != 0 THEN ...`
- Use `CLAMP()` or `MAX()` to ensure non-zero

**"Undefined static variable"**
- Always initialize: `static.var = static.var || 0`
- Check spelling consistency

**"Invalid syntax"**
- Check quotation marks around signal names
- Verify all parentheses match
- Look for typos in keywords (IF, THEN, ELSE, AND, OR, NOT)

**"Expression times out"**
- Avoid infinite loops in state machines
- Check conditional logic for missing exit conditions

---

**End of Expression Language Reference**

For technical support or to report issues, refer to the system documentation or contact your system administrator.
