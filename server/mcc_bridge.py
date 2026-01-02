# server/mcc_bridge.py
import asyncio
from typing import List, Optional

BRIDGE_VERSION = "0.5.4"  # Fixed mcculw TC handling - types configured in InstaCal, not via API

# ---------- Try mcculw (E-1608 AI/AO/DO and optional TCs) ----------
HAVE_MCCULW = False
try:
    from mcculw import ul
    from mcculw.enums import (
        ULRange,
        DigitalPortType,
        AnalogInputMode,
        TempScale as MCCTempScale,
    )
    HAVE_MCCULW = True
except Exception as e:
    ul = None  # type: ignore
    HAVE_MCCULW = False
    print(f"[MCCBridge] mcculw import failed: {e}")

# ---------- Try ULDAQ (E-TC preferred path) ----------
HAVE_ULDAQ = False
HAVE_ULDAQ_CFG = False
try:
    import uldaq
    from uldaq import (
        get_daq_device_inventory,
        DaqDevice,
        InterfaceType,
        TempScale,
        TInFlags,
        ThermocoupleType,
    )
    HAVE_ULDAQ = True
    try:
        from uldaq import ConfigItem  # some builds expose this
        HAVE_ULDAQ_CFG = True
    except Exception:
        HAVE_ULDAQ_CFG = False
except Exception as e:
    # On Windows this usually fails because libuldaq.so/.dll isn't present
    HAVE_ULDAQ = False
    HAVE_ULDAQ_CFG = False
    # Define a stub so _TC_MAP_ULDAQ construction doesn't crash
    ThermocoupleType = None  # type: ignore
    print(f"[MCCBridge] uldaq import failed: {e}")

# Optional MCC thermocouple enum (not on all installs)
MCCTcType = None
if HAVE_MCCULW:
    try:
        from mcculw.enums import TcType as MCCTcType  # type: ignore
    except Exception:
        MCCTcType = None

from app_models import AppConfig

# ---------- TC type maps ----------
_TC_MAP_ULDAQ = {
    "J": ThermocoupleType.J if HAVE_ULDAQ and ThermocoupleType else None,
    "K": ThermocoupleType.K if HAVE_ULDAQ and ThermocoupleType else None,
    "T": ThermocoupleType.T if HAVE_ULDAQ and ThermocoupleType else None,
    "E": ThermocoupleType.E if HAVE_ULDAQ and ThermocoupleType else None,
    "N": ThermocoupleType.N if HAVE_ULDAQ and ThermocoupleType else None,
    "B": ThermocoupleType.B if HAVE_ULDAQ and ThermocoupleType else None,
    "R": ThermocoupleType.R if HAVE_ULDAQ and ThermocoupleType else None,
    "S": ThermocoupleType.S if HAVE_ULDAQ and ThermocoupleType else None,
}

_TC_MAP_MCC = {
    "J": getattr(MCCTcType, "J", None) if MCCTcType else None,
    "K": getattr(MCCTcType, "K", None) if MCCTcType else None,
    "T": getattr(MCCTcType, "T", None) if MCCTcType else None,
    "E": getattr(MCCTcType, "E", None) if MCCTcType else None,
    "N": getattr(MCCTcType, "N", None) if MCCTcType else None,
    "B": getattr(MCCTcType, "B", None) if MCCTcType else None,
    "R": getattr(MCCTcType, "R", None) if MCCTcType else None,
    "S": getattr(MCCTcType, "S", None) if MCCTcType else None,
}


class AIFrame:
    def __init__(self, vals: List[float]):
        self.vals = vals


class MCCBridge:
    def __init__(self):
        self.cfg: Optional[AppConfig] = None

        # AO/DO soft mirrors for UI snapshots
        self._do_bits = [0] * 8
        self._ao_vals = [0.0, 0.0]
        self._do_active_high = [True] * 8
        self._buzz_tasks = {}

        # E-TC handles
        self._etc_uldaq_dev: Optional[DaqDevice] = None
        self._etc_uldaq_tdev = None
        self._etc_uldaq_ok = False

        self._etc_mcc_board: Optional[int] = None

        # Avoid re-writing TC type every sample
        self._tc_type_set_cache = {}  # ch -> "K"/"J"/...
        # AUTO-DETECTION: Track if we've detected TCs yet (runtime only, not saved)
        self._tc_detected = False
        self._tc_runtime_include = {}  # ch -> bool (runtime override)

    # ---------------- Lifecycle ----------------
    def open(self, cfg: AppConfig):
        self.cfg = cfg

        # Configure E-1608 DIO direction and AI mode on mcculw path if available
        if HAVE_MCCULW:
            try:
                # DIO: AUXPORT -> OUT (8 bits)
                ul.d_config_port(
                    cfg.board1608.boardNum,
                    DigitalPortType.AUXPORT,
                    1,  # 1 == OUT
                )
                print("[MCCBridge] DIO configured AUXPORT -> OUT")
            except Exception as e:
                print(f"[MCCBridge] DIO config warn: {e}")
            try:
                mode = (
                    AnalogInputMode.SINGLE_ENDED
                    if str(cfg.board1608.aiMode).upper().startswith("SE")
                    else AnalogInputMode.DIFFERENTIAL
                )
                ul.a_input_mode(cfg.board1608.boardNum, mode)
                print(f"[MCCBridge] AI mode -> {mode.name}")
            except Exception as e:
                print(f"[MCCBridge] AI mode set warn: {e}")

        # Try ULDAQ for E-TC
        self._etc_uldaq_ok = False
        self._etc_uldaq_dev = None
        self._etc_uldaq_tdev = None
        if HAVE_ULDAQ:
            try:
                inv = get_daq_device_inventory(InterfaceType.ETHERNET)
                if not inv:
                    inv = get_daq_device_inventory(InterfaceType.ANY)
                if inv and 0 <= cfg.boardetc.boardNum < len(inv):
                    dev = DaqDevice(inv[cfg.boardetc.boardNum])
                    dev.connect()
                    tdev = dev.get_temp_device()
                    if tdev is not None:
                        self._etc_uldaq_dev = dev
                        self._etc_uldaq_tdev = tdev
                        self._etc_uldaq_ok = True
                        print("[MCCBridge] E-TC via ULDAQ ready")
            except Exception as e:
                print(f"[MCCBridge] ULDAQ E-TC open failed: {e}")

        # Fallback to mcculw for E-TC (cbTIn) if available
        self._etc_mcc_board = None
        if not self._etc_uldaq_ok and HAVE_MCCULW:
            try:
                self._etc_mcc_board = cfg.boardetc.boardNum
                # Smoke test read (ignore value)
                _ = ul.t_in(self._etc_mcc_board, 0, MCCTempScale.CELSIUS)
                print("[MCCBridge] E-TC via mcculw ready")
                print("[MCCBridge] NOTE: TC types must be configured in InstaCal (not via API)")
            except Exception as e:
                self._etc_mcc_board = None
                print(f"[MCCBridge] mcculw E-TC open failed: {e}")

    def close(self):
        # Ensure DOs off if you want a safe state (optional):
        # for i in range(8): self.set_do(i, False, active_high=True)
        if self._etc_uldaq_ok and self._etc_uldaq_dev:
            try:
                self._etc_uldaq_dev.disconnect()
            except Exception:
                pass
        self._etc_uldaq_ok = False
        self._etc_uldaq_dev = None
        self._etc_uldaq_tdev = None
        self._etc_mcc_board = None

    # ---------------- Analog Inputs (E-1608) ----------------
    def read_ai_all(self) -> List[float]:
        """Return 8 AI channels in volts (eng units). Simulator only if no driver."""
        if not HAVE_MCCULW:
            # Simulator (only if absolutely no driver)
            import math, time

            t = time.time()
            return [
                0.5 * math.sin(2 * math.pi * (0.2 + i * 0.07) * t)
                for i in range(8)
            ]
        vals: List[float] = []
        bd = self.cfg.board1608.boardNum
        rng = ULRange.BIP10VOLTS
        for ch in range(8):
            try:
                raw = ul.a_in(bd, ch, rng)  # raw counts
                v = ul.to_eng_units(bd, rng, raw)  # volts
            except Exception as e:
                print(f"[MCCBridge] AI ch{ch} read failed: {e}")
                v = float("nan")
            vals.append(v)
        return vals

    # ---------------- Thermocouples (E-TC) ----------------
    def _set_tc_type(self, ch: int, typ: str):
        """Set TC type for channel. ULDAQ only - mcculw uses InstaCal configuration."""
        t = (typ or "K").upper()
        
        # ULDAQ path (if config API present)
        if (
            self._etc_uldaq_ok
            and HAVE_ULDAQ
            and HAVE_ULDAQ_CFG
            and self._etc_uldaq_dev is not None
        ):
            try:
                tc_enum = _TC_MAP_ULDAQ.get(t)
                if tc_enum is not None:
                    # ConfigItem name varies across builds
                    try:
                        self._etc_uldaq_dev.get_config().set_cfg(
                            ConfigItem.TEMP_SENSOR_TYPE, ch, tc_enum
                        )  # type: ignore
                    except Exception:
                        self._etc_uldaq_dev.get_config().set_cfg(
                            ConfigItem.TEMPERATURE_SENSOR_TYPE, ch, tc_enum
                        )  # type: ignore
                    self._tc_type_set_cache[ch] = t
                    print(f"[MCCBridge] TC{ch} type SET to '{t}' via ULDAQ")
                    return True
            except Exception as e:
                print(f"[MCCBridge] ULDAQ set TC{ch} type '{t}' FAILED: {e}")
                return False

        # mcculw path: TC types are configured in InstaCal, not via API
        # We just cache the expected type for reference but don't set it
        if HAVE_MCCULW and self._etc_mcc_board is not None:
            self._tc_type_set_cache[ch] = t
            # Don't print warning every time - just note it once during init
            return True
        
        # No TC hardware available
        return False

    def read_tc_all(self) -> List[float]:
        """Return enabled TC channels (ordered by config.thermocouples).
        Auto-detects working channels on first call. Missing driver -> []."""
        if self.cfg is None:
            return []

        # AUTO-DETECTION: On first call, probe all channels to see which are present
        if not self._tc_detected:
            self._tc_detected = True
            
            # STEP 1: Configure TC types (ULDAQ only, mcculw uses InstaCal)
            if self._etc_uldaq_ok:
                print("[MCCBridge] Configuring TC types via ULDAQ...")
                for rec in self.cfg.thermocouples:
                    ch = int(rec.ch)
                    tc_type = (rec.type or "K").upper()
                    print(f"[MCCBridge] Setting TC{ch} ({rec.name}) to type '{tc_type}'...")
                    success = self._set_tc_type(ch, tc_type)
                    if not success:
                        print(f"[MCCBridge] WARNING: Failed to set TC{ch} type!")
            elif HAVE_MCCULW and self._etc_mcc_board is not None:
                print("[MCCBridge] Using mcculw E-TC - TC types configured in InstaCal")
                # Just cache the expected types from config
                for rec in self.cfg.thermocouples:
                    ch = int(rec.ch)
                    tc_type = (rec.type or "K").upper()
                    self._tc_type_set_cache[ch] = tc_type
            
            # Print configuration summary
            if self._tc_type_set_cache:
                print("[MCCBridge] TC Type Configuration Summary:")
                for rec in self.cfg.thermocouples:
                    ch = int(rec.ch)
                    cached_type = self._tc_type_set_cache.get(ch, "NOT SET")
                    config_type = (rec.type or "K").upper()
                    if self._etc_uldaq_ok:
                        match = "✓" if cached_type == config_type else "✗"
                        print(f"[MCCBridge]   TC{ch} ({rec.name}): Config={config_type}, Set={cached_type} {match}")
                    else:
                        print(f"[MCCBridge]   TC{ch} ({rec.name}): Expected={config_type} (configured in InstaCal)")
            
            # STEP 2: Auto-detect which channels are actually present
            print("[MCCBridge] Auto-detecting connected thermocouples...")

            # Probe EVERY configured channel to see if it actually works
            for rec in self.cfg.thermocouples:
                ch = int(rec.ch)
                detected = False
                val = 0.0

                # Try ULDAQ path
                if self._etc_uldaq_ok and self._etc_uldaq_tdev is not None:
                    try:
                        # Type already set above, just read
                        val = self._etc_uldaq_tdev.t_in(ch, TempScale.CELSIUS, TInFlags.DEFAULT)
                        # Check if we got a reasonable value (not open circuit error)
                        if -200 < val < 2000:  # Reasonable TC range
                            detected = True
                    except Exception:
                        # Channel not present - this is expected for missing TCs
                        detected = False

                # Try mcculw fallback
                elif HAVE_MCCULW and self._etc_mcc_board is not None:
                    try:
                        # Read without setting type (configured in InstaCal)
                        val = ul.t_in(self._etc_mcc_board, ch, MCCTempScale.CELSIUS)
                        # Check if we got a reasonable value
                        if -200 < val < 2000:  # Reasonable TC range
                            detected = True
                    except Exception:
                        # Channel not present - this is expected for missing TCs
                        detected = False

                # Always store detection result (overrides config during runtime)
                self._tc_runtime_include[ch] = detected

                config_status = "enabled in config" if rec.include else "disabled in config"
                if detected:
                    print(f"[MCCBridge] ✓ TC channel {ch} ({rec.name}) detected at {val:.1f}°C ({config_status})")
                else:
                    print(f"[MCCBridge] ✗ TC channel {ch} ({rec.name}) NOT detected, will be skipped ({config_status})")

            enabled = [ch for ch, en in self._tc_runtime_include.items() if en]
            print(f"[MCCBridge] TC detection complete. Active channels: {enabled}")

        # Build lists of ONLY detected channels (ignores config include setting)
        enabled_channels: List[int] = []
        types: List[str] = []
        names: List[str] = []

        for rec in self.cfg.thermocouples:
            ch = int(rec.ch)
            # Only use channels that were actually detected
            if self._tc_runtime_include.get(ch, False):
                enabled_channels.append(ch)
                types.append(rec.type or "K")
                names.append(rec.name or f"TC{ch}")

        if not enabled_channels:
            return []

        # ULDAQ path - only read detected channels
        if self._etc_uldaq_ok and self._etc_uldaq_tdev is not None:
            out: List[float] = []
            for i, ch in enumerate(enabled_channels):
                tc_type = types[i] if i < len(types) else "K"
                # Type already set during detection, just read
                try:
                    val = self._etc_uldaq_tdev.t_in(
                        int(ch), TempScale.CELSIUS, TInFlags.DEFAULT
                    )
                    out.append(float(val))
                except Exception as e:
                    print(f"[MCCBridge] ULDAQ t_in ch{ch} ({names[i]}) unexpected error: {e}")
                    out.append(float("nan"))
            return out

        # mcculw fallback (cbTIn) - only read detected channels
        # TC types configured in InstaCal, not via API
        if HAVE_MCCULW and self._etc_mcc_board is not None:
            out = []
            for i, ch in enumerate(enabled_channels):
                try:
                    val = ul.t_in(self._etc_mcc_board, int(ch), MCCTempScale.CELSIUS)
                    out.append(float(val))
                except Exception as e:
                    print(f"[MCCBridge] MCC t_in ch{ch} ({names[i]}) unexpected error: {e}")
                    out.append(float("nan"))
            return out

        # No driver
        return []

    # ---------------- Digital Outputs (E-1608) ----------------
    def set_do(self, index: int, state: bool, active_high=True):
        assert 0 <= index < 8
        logical = bool(state)
        phys = 1 if (logical == bool(active_high)) else 0
        self._do_bits[index] = 1 if logical else 0
        if HAVE_MCCULW:
            try:
                ul.d_bit_out(
                    self.cfg.board1608.boardNum,
                    DigitalPortType.AUXPORT,
                    index,
                    phys,
                )
            except Exception as e:
                print(f"[MCCBridge] DO ch{index} write failed: {e}")

    # --- DO buzz: one cancellable task per channel; STOP always forces OFF ---
    async def start_buzz(self, index: int, hz: float, active_high: bool = True):
        self._do_active_high[index] = bool(active_high)
        await self.stop_buzz(index)  # cancel any prior
        period = 1.0 / max(0.1, float(hz))

        async def _worker():
            on = False
            try:
                while True:
                    on = not on
                    self.set_do(index, on, active_high=self._do_active_high[index])
                    await asyncio.sleep(period / 2.0)
            except asyncio.CancelledError:
                # guarantee OFF on cancel
                self.set_do(index, False, active_high=self._do_active_high[index])
                raise

        self._buzz_tasks[index] = asyncio.create_task(_worker())

    async def stop_buzz(self, index: int):
        t = self._buzz_tasks.pop(index, None)
        if t:
            t.cancel()
            try:
                await t
            except asyncio.CancelledError:
                pass
            except Exception:
                pass
        # double-ensure OFF in case there was no task
        self.set_do(index, False, active_high=self._do_active_high[index])

    def get_do_snapshot(self):
        return list(self._do_bits)

    # ---------------- Analog Outputs (E-1608) ----------------
    @property
    def ao_cache(self):
        """Expose AO values for PID feedback"""
        return self._ao_vals

    def _dac_counts(self, volts: float) -> int:
        """Convert volts to 16-bit DAC code for ±10 V range (BIP10V).
        Clamps to [-10.0, +10.0], returns integer in [0, 65535].
        """
        try:
            v = float(volts)
        except Exception:
            v = 0.0
        # Clamp to device range
        if v < -10.0:
            v = -10.0
        if v > +10.0:
            v = +10.0

        # Preferred: library conversion (handles calibration)
        if HAVE_MCCULW and (ul is not None) and self.cfg is not None:
            try:
                return int(
                    ul.from_eng_units(
                        self.cfg.board1608.boardNum,
                        ULRange.BIP10VOLTS,
                        v,
                    )
                )
            except Exception as e:
                print(f"[MCCBridge] from_eng_units failed, using math: {e}")

        # Fallback math: map [-10, +10] -> [0, 65535]
        # LSB ≈ 20 V / 65535 ≈ 0.000305 V
        code = int(round((v + 10.0) * (65535.0 / 20.0)))
        if code < 0:
            code = 0
        if code > 65535:
            code = 65535
        return code

    def set_ao(self, index: int, volts: float):
        assert 0 <= index < 2
        # Store the requested voltage for UI echo
        try:
            self._ao_vals[index] = float(volts)
        except Exception:
            self._ao_vals[index] = 0.0

        code = self._dac_counts(volts)  # ALWAYS int [0..65535]

        if HAVE_MCCULW and (ul is not None) and self.cfg is not None:
            try:
                # IMPORTANT: Use BIP10VOLTS for E-1608 (AO is ±10 V)
                ul.a_out(
                    self.cfg.board1608.boardNum,
                    index,
                    ULRange.BIP10VOLTS,
                    int(code),
                )
            except Exception as e:
                print(f"[MCCBridge] AO ch{index} write failed: {e}")
        # If no hardware, snapshot already updated; nothing else to do.

    def get_ao_snapshot(self):
        return list(self._ao_vals)


if __name__ == "__main__":
    # Offline sanity check for E-1608 AO code mapping (±10 V -> 0..65535).
    def to_code(v):
        v = max(-10.0, min(10.0, float(v)))
        return int(round((v + 10.0) * (65535.0 / 20.0)))

    for val in [-12, -10, -5, 0, 5, 10, 12]:
        code = to_code(val)
        print(f"{val:>6.2f} V -> code {code:5d}")
