# acq_scope.py - Scope Mode Acquisition & Trigger Detection
__version__ = "1.0.5"  # CRITICAL: Decimate sweeps >2000 samples to prevent websocket crashes!

"""
SCOPE MODE ARCHITECTURE:
- Processes ALL samples as fast as they arrive
- Maintains large processed buffer for pre-trigger samples
- Detects triggers in real-time
- Sends complete triggered sweeps to frontend
- Supports Auto/Normal/Single trigger modes
- Display updates independent of acquisition rate
"""

import asyncio
import time
from collections import deque
from typing import List, Dict, Optional, Callable

# Scope trigger state
class ScopeTriggerState:
    def __init__(self):
        self.enabled = False
        self.mode = 'auto'  # 'auto', 'normal', 'single'
        self.source_index = 0  # Which AI channel to trigger on
        self.level = 0.0
        self.edge = 'rising'  # 'rising' or 'falling'
        self.position = 50  # 0-100% where trigger appears on display
        self.time_per_div = 0.001  # seconds per division (1ms default)
        self.armed = True
        self.last_trigger_time = 0.0
        self.last_auto_update = 0.0
        self.max_update_rate_hz = 200.0  # Max display updates in auto mode
        
        # Calculated values (will be updated when hw_sample_rate is known)
        self.samples_needed = 0  # Will be calculated from time_per_div × 10 × hw_sample_rate
        self.pre_trigger_samples = 0
        self.post_trigger_samples = 0

    def update_sample_counts(self, hw_sample_rate: float):
        """Calculate how many samples needed based on timebase and sample rate"""
        total_time = self.time_per_div * 10  # 10 divisions
        self.samples_needed = int(total_time * hw_sample_rate)
        self.pre_trigger_samples = int(self.samples_needed * self.position / 100)
        self.post_trigger_samples = self.samples_needed - self.pre_trigger_samples
        
        print(f"[SCOPE] Updated sample counts: total={self.samples_needed}, "
              f"pre={self.pre_trigger_samples}, post={self.post_trigger_samples}")


class ScopeProcessor:
    """
    Processes samples for scope mode and detects triggers
    """
    def __init__(self, broadcast_func: Callable):
        self.broadcast = broadcast_func
        self.trigger_state = ScopeTriggerState()
        
        # Processed sample buffer (large for pre-trigger)
        # Each sample: {t: timestamp, ai: [ch0, ch1, ...], ao: [...], do: [...], ...}
        self.processed_buffer = deque(maxlen=50000)  # Up to 50k samples for pre-trigger
        
        self.stats_last_time = time.perf_counter()
        self.stats_samples_processed = 0
        self.stats_triggers_found = 0
        
    def configure_trigger(self, **kwargs):
        """Update trigger configuration"""
        if 'enabled' in kwargs:
            self.trigger_state.enabled = bool(kwargs['enabled'])
        if 'mode' in kwargs:
            self.trigger_state.mode = str(kwargs['mode'])
            self.trigger_state.armed = True  # Re-arm on mode change
        if 'source_index' in kwargs:
            self.trigger_state.source_index = int(kwargs['source_index'])
        if 'level' in kwargs:
            self.trigger_state.level = float(kwargs['level'])
        if 'edge' in kwargs:
            self.trigger_state.edge = str(kwargs['edge'])
        if 'position' in kwargs:
            self.trigger_state.position = max(0, min(100, int(kwargs['position'])))
            # Recalculate pre/post trigger samples when position changes
            if hasattr(self.trigger_state, '_last_hw_rate'):
                print(f"[SCOPE-CONFIG] Position changed to {self.trigger_state.position}%, recalculating...")
                self.trigger_state.update_sample_counts(self.trigger_state._last_hw_rate)
        if 'time_per_div' in kwargs:
            self.trigger_state.time_per_div = float(kwargs['time_per_div'])
            print(f"[SCOPE-CONFIG] Time/div changed to {self.trigger_state.time_per_div}s, recalculating...")
            # Recalculate samples needed when timebase changes
            if hasattr(self.trigger_state, '_last_hw_rate'):
                self.trigger_state.update_sample_counts(self.trigger_state._last_hw_rate)
            else:
                print(f"[SCOPE-CONFIG] WARNING: No _last_hw_rate stored yet!")
        if 'hw_sample_rate' in kwargs:
            hw_rate = float(kwargs['hw_sample_rate'])
            print(f"[SCOPE-CONFIG] HW rate set to {hw_rate} Hz")
            self.trigger_state._last_hw_rate = hw_rate  # Store for later recalculations
            self.trigger_state.update_sample_counts(hw_rate)
        if 'armed' in kwargs:
            self.trigger_state.armed = bool(kwargs['armed'])
            
        return self.trigger_state
    
    def process_samples(self, samples: List[Dict], hw_sample_rate: float):
        """
        Process a batch of samples and check for triggers
        
        Args:
            samples: List of processed sample dicts {t, ai, ao, do, tc, pid, math, expr, ...}
            hw_sample_rate: Current hardware sample rate
        """
        if not samples:
            return
        
        # Add to processed buffer
        self.processed_buffer.extend(samples)
        self.stats_samples_processed += len(samples)
        
        # Update sample counts if needed
        if self.trigger_state.samples_needed == 0:
            self.trigger_state.update_sample_counts(hw_sample_rate)
        
        # Check if we should look for triggers or send auto updates
        now = time.perf_counter()
        
        if self.trigger_state.mode == 'auto':
            # Auto mode: Send updates at max rate even without trigger
            min_interval = 1.0 / self.trigger_state.max_update_rate_hz
            time_since_last = now - self.trigger_state.last_auto_update
            
            if time_since_last >= min_interval:
                print(f"[SCOPE-AUTO] Sending auto update (interval: {time_since_last:.3f}s)")
                self._send_auto_update()
                self.trigger_state.last_auto_update = now
        
        elif self.trigger_state.mode in ['normal', 'single'] and self.trigger_state.armed:
            # Normal/Single: Only send on trigger
            triggered, trigger_idx = self._detect_trigger()
            
            if triggered and trigger_idx >= 0:
                self._send_triggered_sweep(trigger_idx)
                self.stats_triggers_found += 1
                
                # Single mode: disarm after trigger
                if self.trigger_state.mode == 'single':
                    self.trigger_state.armed = False
                    print("[SCOPE] Single trigger captured, disarmed")
        
        # Stats every 5 seconds
        if (now - self.stats_last_time) > 5.0:
            elapsed = now - self.stats_last_time
            rate = self.stats_samples_processed / elapsed
            print(f"[SCOPE] Processed {rate:.0f} samples/sec | "
                  f"Buffer: {len(self.processed_buffer)} | "
                  f"Triggers: {self.stats_triggers_found}")
            self.stats_samples_processed = 0
            self.stats_triggers_found = 0
            self.stats_last_time = now
    
    def _detect_trigger(self) -> tuple:
        """
        Search buffer for trigger event
        
        Returns: (triggered, trigger_index)
        """
        buffer = self.processed_buffer
        
        # Need enough samples for pre-trigger
        if len(buffer) < self.trigger_state.pre_trigger_samples + 10:
            return False, -1
        
        source_idx = self.trigger_state.source_index
        level = self.trigger_state.level
        edge = self.trigger_state.edge
        
        # Search recent samples (last 1000 or so)
        search_depth = min(1000, len(buffer) - 1)
        start_idx = len(buffer) - search_depth
        
        for i in range(start_idx, len(buffer) - 1):
            try:
                prev_sample = buffer[i]
                cur_sample = buffer[i + 1]
                
                if 'ai' not in prev_sample or 'ai' not in cur_sample:
                    continue
                
                if source_idx >= len(prev_sample['ai']) or source_idx >= len(cur_sample['ai']):
                    continue
                
                prev_val = prev_sample['ai'][source_idx]
                cur_val = cur_sample['ai'][source_idx]
                
                # Check trigger condition
                if edge == 'rising':
                    if prev_val < level and cur_val >= level:
                        return True, i + 1  # Trigger on current sample
                else:  # falling
                    if prev_val > level and cur_val <= level:
                        return True, i + 1
                        
            except (KeyError, IndexError):
                continue
        
        return False, -1
    
    def _send_triggered_sweep(self, trigger_idx: int):
        """Extract and send triggered sweep to frontend"""
        buffer = self.processed_buffer
        
        # Calculate sweep boundaries
        start_idx = trigger_idx - self.trigger_state.pre_trigger_samples
        end_idx = trigger_idx + self.trigger_state.post_trigger_samples
        
        # Check if we have enough samples for a complete sweep
        if start_idx < 0:
            # Not enough pre-trigger samples yet - skip this trigger
            print(f"[SCOPE] Skipping trigger at {trigger_idx}: need {self.trigger_state.pre_trigger_samples} pre-trigger, only have {trigger_idx}")
            return
        
        if end_idx > len(buffer):
            # Not enough post-trigger samples yet - skip this trigger
            print(f"[SCOPE] Skipping trigger at {trigger_idx}: need {self.trigger_state.post_trigger_samples} post-trigger, only have {len(buffer) - trigger_idx}")
            return
        
        # Extract sweep samples (no clamping - we verified bounds above)
        sweep_samples = [buffer[i] for i in range(start_idx, end_idx)]
        
        # Verify we got the expected number of samples
        if len(sweep_samples) != self.trigger_state.samples_needed:
            print(f"[SCOPE] WARNING: Sweep has {len(sweep_samples)} samples, expected {self.trigger_state.samples_needed}")
        
        # DECIMATE if too many samples (websocket message size limit)
        max_samples = 2000
        original_count = len(sweep_samples)
        decimation_factor = 1
        if len(sweep_samples) > max_samples:
            decimation_factor = len(sweep_samples) // max_samples
            sweep_samples = sweep_samples[::decimation_factor]
            print(f"[SCOPE] Decimated triggered sweep: {original_count} → {len(sweep_samples)} samples (factor: {decimation_factor})")
        
        # Send to frontend
        sweep_msg = {
            'type': 'scope_sweep',
            'mode': self.trigger_state.mode,
            'triggered': True,
            'trigger_index': (trigger_idx - start_idx) // decimation_factor,
            'samples': sweep_samples,
            'time_per_div': self.trigger_state.time_per_div,
            'trigger_level': self.trigger_state.level,
            'trigger_position': self.trigger_state.position
        }
        
        # DEBUG: Check what's in first sample
        if sweep_samples and len(sweep_samples) > 0:
            first_sample = sweep_samples[0]
            ai_count = len(first_sample.get('ai', [])) if isinstance(first_sample, dict) else 0
            print(f"[SCOPE-SEND] Broadcasting {len(sweep_samples)} samples, first sample AI count: {ai_count}, keys: {list(first_sample.keys()) if isinstance(first_sample, dict) else 'NOT A DICT'}")
        
        asyncio.create_task(self.broadcast(sweep_msg))
        
        print(f"[SCOPE] Sent triggered sweep: {len(sweep_samples)} samples, "
              f"trigger at sample {(trigger_idx - start_idx) // decimation_factor}")
    
    def _send_auto_update(self):
        """Send auto-mode update (may not be triggered)"""
        buffer = self.processed_buffer
        
        if len(buffer) < self.trigger_state.samples_needed:
            return
        
        # Try to find trigger in recent samples
        triggered, trigger_idx = self._detect_trigger()
        
        if triggered and trigger_idx >= 0:
            # Found trigger - send aligned sweep
            self._send_triggered_sweep(trigger_idx)
        else:
            # No trigger - send most recent samples
            sweep_samples = [buffer[i] for i in range(
                len(buffer) - self.trigger_state.samples_needed,
                len(buffer)
            )]
            
            # DECIMATE if too many samples (websocket message size limit)
            # Screen is only ~1400px wide, so more than 2000 samples is wasteful
            max_samples = 2000
            if len(sweep_samples) > max_samples:
                # Decimate: take every Nth sample
                decimation_factor = len(sweep_samples) // max_samples
                sweep_samples = sweep_samples[::decimation_factor]
                print(f"[SCOPE-AUTO] Decimated {self.trigger_state.samples_needed} → {len(sweep_samples)} samples (factor: {decimation_factor})")
            
            print(f"[SCOPE-AUTO] Sending non-triggered sweep: {len(sweep_samples)} samples")
            print(f"[SCOPE-AUTO-DEBUG] sweep_samples type: {type(sweep_samples)}, length: {len(sweep_samples) if sweep_samples else 0}")
            
            # DEBUG: Check first sample content  
            if sweep_samples and len(sweep_samples) > 0:
                first_sample = sweep_samples[0]
                ai_count = len(first_sample.get('ai', [])) if isinstance(first_sample, dict) else 0
                ai_vals = first_sample.get('ai', [])[:3] if isinstance(first_sample, dict) else []
                print(f"[SCOPE-AUTO-DEBUG] First sample: {ai_count} AI, first 3 vals: {ai_vals}")
            else:
                print(f"[SCOPE-AUTO-DEBUG] NO SAMPLES IN sweep_samples!")
            
            asyncio.create_task(self.broadcast({
                'type': 'scope_sweep',
                'mode': 'auto',
                'triggered': False,
                'trigger_index': -1,
                'samples': sweep_samples,
                'time_per_div': self.trigger_state.time_per_div
            }))
