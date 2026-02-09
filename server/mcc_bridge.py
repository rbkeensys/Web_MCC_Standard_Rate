# server/mcc_bridge.py
__version__ = "3.0.2"  # Added read_ai_all_burst with board_filter parameter
BRIDGE_VERSION = "2.0.6"  # Fixed missing imports

import asyncio
from typing import List, Optional


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

        # Multi-board support: store all enabled boards
        self._boards_1608 = []  # List of E-1608 board numbers
        self._boards_etc_uldaq = []  # List of (board_num, dev, tdev) tuples for ULDAQ
        self._boards_etc_mcc = []  # List of E-TC board numbers for mcculw

        # AO/DO soft mirrors - sized dynamically based on board count
        self._do_bits = []  # num_1608_boards * 8
        self._ao_vals = []  # num_1608_boards * 2
        self._do_active_high = []
        self._buzz_tasks = {}

        # TC type cache - now indexed by global channel index
        self._tc_type_set_cache = {}  # global_ch -> "K"/"J"/...
        # AUTO-DETECTION
        self._tc_detected = False
        self._tc_runtime_include = {}  # global_ch -> bool

    # ---------------- Lifecycle ----------------
    def open(self, cfg: AppConfig):
        """Open and configure ALL enabled boards"""
        self.cfg = cfg
        
        # Clear previous board lists
        self._boards_1608 = []
        self._boards_etc_uldaq = []
        self._boards_etc_mcc = []
        
        # === Configure ALL E-1608 boards ===
        if cfg.boards1608:
            for board_cfg in cfg.boards1608:
                if not board_cfg.enabled:
                    continue
                    
                board_num = board_cfg.boardNum
                self._boards_1608.append(board_num)
                
                if HAVE_MCCULW:
                    try:
                        # DIO: AUXPORT -> OUT (8 bits)
                        ul.d_config_port(board_num, DigitalPortType.AUXPORT, 1)
                        print(f"[MCCBridge] E-1608 #{board_num}: DIO configured AUXPORT -> OUT")
                    except Exception as e:
                        print(f"[MCCBridge] E-1608 #{board_num}: DIO config warn: {e}")
                    
                    try:
                        mode = (
                            AnalogInputMode.SINGLE_ENDED
                            if str(board_cfg.aiMode).upper().startswith("SE")
                            else AnalogInputMode.DIFFERENTIAL
                        )
                        ul.a_input_mode(board_num, mode)
                        print(f"[MCCBridge] E-1608 #{board_num}: AI mode -> {mode.name}")
                    except Exception as e:
                        print(f"[MCCBridge] E-1608 #{board_num}: AI mode warn: {e}")
        
        num_1608 = len(self._boards_1608)
        print(f"[MCCBridge] Configured {num_1608} E-1608 board(s)")
        
        # Initialize DO/AO mirrors for all boards
        self._do_bits = [0] * (num_1608 * 8)
        self._ao_vals = [0.0] * (num_1608 * 2)
        self._do_active_high = [True] * (num_1608 * 8)
        
        # === Configure ALL E-TC boards ===
        if cfg.boardsetc:
            for board_cfg in cfg.boardsetc:
                if not board_cfg.enabled:
                    continue
                
                board_num = board_cfg.boardNum
                
                # Try ULDAQ first
                opened_uldaq = False
                if HAVE_ULDAQ:
                    try:
                        inv = get_daq_device_inventory(InterfaceType.ETHERNET)
                        if not inv:
                            inv = get_daq_device_inventory(InterfaceType.ANY)
                        if inv and 0 <= board_num < len(inv):
                            dev = DaqDevice(inv[board_num])
                            dev.connect()
                            tdev = dev.get_temp_device()
                            if tdev is not None:
                                self._boards_etc_uldaq.append((board_num, dev, tdev))
                                print(f"[MCCBridge] E-TC #{board_num}: opened via ULDAQ")
                                opened_uldaq = True
                    except Exception as e:
                        print(f"[MCCBridge] E-TC #{board_num}: ULDAQ failed: {e}")
                
                # Fallback to mcculw if ULDAQ didn't work
                if not opened_uldaq and HAVE_MCCULW:
                    try:
                        # Smoke test
                        try:
                            _ = ul.t_in(board_num, 0, MCCTempScale.CELSIUS)
                        except Exception as e:
                            err_str = str(e).lower()
                            if "open connection" not in err_str and "open circuit" not in err_str:
                                raise
                        self._boards_etc_mcc.append(board_num)
                        print(f"[MCCBridge] E-TC #{board_num}: opened via mcculw")
                    except Exception as e:
                        print(f"[MCCBridge] E-TC #{board_num}: mcculw failed: {e}")
        
        total_etc = len(self._boards_etc_uldaq) + len(self._boards_etc_mcc)
        print(f"[MCCBridge] Configured {total_etc} E-TC board(s)")

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
    def read_ai_all(self, board_filter=None):
        """
        Read AI from E-1608 boards, return concatenated list
        
        Args:
            board_filter: Optional list of board numbers to read from. If None, reads all boards.
        """
        all_values = []
        
        boards_to_read = board_filter if board_filter is not None else self._boards_1608
        
        for board_num in boards_to_read:
            if board_num not in self._boards_1608:
                continue  # Skip boards not in our list
                
            board_values = [0.0] * 8  # Default if read fails
            
            if HAVE_MCCULW:
                try:
                    # Read all 8 channels from this board
                    for ch in range(8):
                        raw = ul.a_in(board_num, ch, ULRange.BIP10VOLTS)  # Raw counts
                        val = ul.to_eng_units(board_num, ULRange.BIP10VOLTS, raw)  # Convert to volts
                        board_values[ch] = val
                    # Debug first read only
                    if not hasattr(self, '_ai_debug_done'):
                        print(f"[MCCBridge] Board #{board_num} AI read OK: {board_values[:4]}...")
                        self._ai_debug_done = True
                except Exception as e:
                    print(f"[MCCBridge] E-1608 #{board_num} AI read FAILED: {e}")
            else:
                if not hasattr(self, '_mcculw_warn_done'):
                    print(f"[MCCBridge] WARNING: HAVE_MCCULW=False, returning zeros!")
                    self._mcculw_warn_done = True
            
            all_values.extend(board_values)
        
        # Returns [board0_ch0-7, board1_ch0-7, board2_ch0-7, ...]
        return all_values

    def read_ai_all_burst(self, rate_hz: int = 100, samples: int = 50, board_filter=None):
        """
        Read multiple samples in burst mode using hardware scan
        Falls back to sequential reads if scan not available
        
        Args:
            rate_hz: Sampling rate
            samples: Number of samples to read
            board_filter: Optional list of board numbers to read from
            
        Returns:
            List of samples, each sample is list of AI values
        """
        # For now, just do fast sequential reads
        # TODO: Implement proper ul.a_in_scan for true burst mode
        burst_data = []
        for _ in range(samples):
            sample = self.read_ai_all(board_filter=board_filter)
            burst_data.append(sample)
        return burst_data

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

    def read_tc_all(self):
        """Read TC from ALL E-TC boards, return concatenated list"""
        all_values = []
        
        # Get TC configs from all boards
        tc_configs = []
        if self.cfg and self.cfg.boardsetc:
            for board in self.cfg.boardsetc:
                if board.enabled:
                    tc_configs.extend(board.thermocouples)
        
        # Read from ULDAQ boards
        for board_num, dev, tdev in self._boards_etc_uldaq:
            board_values = [float('nan')] * 8
            try:
                # Get which TCs are configured for this board
                board_tcs = []
                if self.cfg and self.cfg.boardsetc:
                    for b in self.cfg.boardsetc:
                        if b.boardNum == board_num and b.enabled:
                            board_tcs = b.thermocouples
                            break
                
                # Read each configured TC
                configured_channels = {int(rec.ch): rec for rec in board_tcs}
                for ch in range(8):
                    if ch in configured_channels and configured_channels[ch].include:
                        rec = configured_channels[ch]
                        tc_type_str = rec.type.upper()
                        tc_type_enum = getattr(TcType, tc_type_str, TcType.K)
                        temp_val = tdev.t_in(ch, TempScale.CELSIUS, tc_type_enum)
                        board_values[ch] = temp_val
            except Exception as e:
                print(f"[MCCBridge] E-TC #{board_num} ULDAQ read failed: {e}")
            
            all_values.extend(board_values)
        
        # Read from mcculw boards
        for board_num in self._boards_etc_mcc:
            board_values = [float('nan')] * 8
            try:
                # Get which TCs are configured for this board
                board_tcs = []
                if self.cfg and self.cfg.boardsetc:
                    for b in self.cfg.boardsetc:
                        if b.boardNum == board_num and b.enabled:
                            board_tcs = b.thermocouples
                            break
                
                # Read each configured TC
                for rec in board_tcs:
                    if rec.include:
                        ch = int(rec.ch)
                        if 0 <= ch < 8:
                            try:
                                temp_val = ul.t_in(board_num, ch, MCCTempScale.CELSIUS)
                                board_values[ch] = temp_val
                            except Exception:
                                # Open circuit is common, leave as nan
                                pass
            except Exception as e:
                print(f"[MCCBridge] E-TC #{board_num} mcculw read failed: {e}")
            
            all_values.extend(board_values)
        
        # Returns [board0_ch0-7, board1_ch0-7, ...]
        return all_values

    def set_do(self, index: int, state: bool, active_high=True):
        """Set DO channel - routes to correct board based on index"""
        # Safety check
        if self.cfg is None:
            return
        
        # Calculate which board and channel
        board_idx = index // 8  # Which board (0, 1, 2...)
        channel = index % 8     # Which channel on that board (0-7)
        
        # Bounds check
        if board_idx >= len(self._boards_1608):
            print(f"[MCCBridge] DO{index}: board index {board_idx} out of range")
            return
        
        board_num = self._boards_1608[board_idx]
        
        # Update mirror
        if index < len(self._do_bits):
            self._do_bits[index] = 1 if state else 0
        if index < len(self._do_active_high):
            self._do_active_high[index] = bool(active_high)
        
        # Write to hardware
        logical = bool(state)
        phys = 1 if (logical == bool(active_high)) else 0
        
        if HAVE_MCCULW:
            try:
                ul.d_bit_out(board_num, DigitalPortType.AUXPORT, channel, phys)
            except Exception as e:
                print(f"[MCCBridge] DO{index} (board #{board_num}, ch{channel}) write failed: {e}")

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

    def _dac_counts(self, volts: float, board_num: int) -> int:
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
        if HAVE_MCCULW and ul is not None:
            try:
                return int(
                    ul.from_eng_units(
                        board_num,
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

    def set_ao(self, index: int, voltage: float):
        """Set AO channel - routes to correct board based on index"""
        # Safety check
        if self.cfg is None:
            return
        
        # Calculate which board and channel
        board_idx = index // 2  # Which board (each E-1608 has 2 AO)
        channel = index % 2     # Which channel on that board (0 or 1)
        
        # Bounds check
        if board_idx >= len(self._boards_1608):
            print(f"[MCCBridge] AO{index}: board index {board_idx} out of range")
            return
        
        board_num = self._boards_1608[board_idx]
        voltage = float(voltage)
        
        # Update mirror
        if index < len(self._ao_vals):
            self._ao_vals[index] = voltage
        
        # Convert to DAC counts
        code = self._dac_counts(voltage, board_num)
        
        # Write to hardware
        if HAVE_MCCULW:
            try:
                ul.a_out(board_num, channel, ULRange.BIP10VOLTS, int(code))
            except Exception as e:
                print(f"[MCCBridge] AO{index} (board #{board_num}, ch{channel}) write failed: {e}")

    def get_ao_snapshot(self):
        return list(self._ao_vals)

    def get_tc_configuration_status(self) -> List[dict]:
        """
        Check TC configuration status and return information for UI.
        For mcculw: We can't read the InstaCal TC type directly, so we return
        the expected types from config and note they need to be verified in InstaCal.
        For ULDAQ: We can verify the actual configured types.
        """
        if self.cfg is None:
            return []
        
        results = []
        
        # Check each configured TC channel
        for rec in self.cfg.thermocouples:
            ch = int(rec.ch)
            expected_type = (rec.type or "K").upper()
            
            status = {
                "channel": ch,
                "name": rec.name or f"TC{ch}",
                "expected_type": expected_type,
                "actual_type": None,  # Can't read from mcculw
                "detected": self._tc_runtime_include.get(ch, False),
                "needs_config": False,
                "config_method": None,
                "include_in_config": rec.include
            }
            
            # ULDAQ path - we can verify the type was set
            if self._etc_uldaq_ok and HAVE_ULDAQ:
                cached = self._tc_type_set_cache.get(ch)
                status["actual_type"] = cached
                status["config_method"] = "ULDAQ API"
                if cached != expected_type:
                    status["needs_config"] = True
            
            # mcculw path - we can't read the type, just inform user
            elif HAVE_MCCULW and self._etc_mcc_board is not None:
                status["actual_type"] = "Unknown (set in InstaCal)"
                status["config_method"] = "InstaCal"
                # Flag detected channels as needing verification since we can't read the type
                status["needs_config"] = status["detected"]
            
            results.append(status)
        
        return results


if __name__ == "__main__":
    # Offline sanity check for E-1608 AO code mapping (±10 V -> 0..65535).
    def to_code(v):
        v = max(-10.0, min(10.0, float(v)))
        return int(round((v + 10.0) * (65535.0 / 20.0)))

    for val in [-12, -10, -5, 0, 5, 10, 12]:
        code = to_code(val)
        print(f"{val:>6.2f} V -> code {code:5d}")
