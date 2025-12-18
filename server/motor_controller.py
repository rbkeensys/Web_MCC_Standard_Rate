# server/motor_controller.py
"""
MODBUS RS232 interface for Rattmotor YPMC-750W servo controller
"""
import serial
import serial.tools.list_ports
import struct
import time
from typing import Optional, List, Dict
import logging

log = logging.getLogger("motor")

class RattmotorYPMC:
    """Interface for Rattmotor YPMC-750W servo controller via MODBUS RS232"""
    
    def __init__(self, port: str, baudrate: int = 9600, address: int = 1):
        self.port = port
        self.baudrate = baudrate
        self.address = address
        self.serial_port: Optional[serial.Serial] = None
        self.connected = False
        
    def connect(self):
        """Open serial connection"""
        try:
            self.serial_port = serial.Serial(
                port=self.port,
                baudrate=self.baudrate,
                bytesize=serial.EIGHTBITS,
                parity=serial.PARITY_NONE,
                stopbits=serial.STOPBITS_ONE,
                timeout=1.0
            )
            self.connected = True
            log.info(f"Connected to motor controller on {self.port}")
            return True
        except Exception as e:
            log.error(f"Failed to connect to {self.port}: {e}")
            self.connected = False
            return False
    
    def disconnect(self):
        """Close serial connection"""
        if self.serial_port and self.serial_port.is_open:
            self.serial_port.close()
            self.connected = False
            log.info(f"Disconnected from {self.port}")
    
    def _calculate_crc(self, data: bytes) -> int:
        """Calculate MODBUS CRC16"""
        crc = 0xFFFF
        for byte in data:
            crc ^= byte
            for _ in range(8):
                if crc & 0x0001:
                    crc = (crc >> 1) ^ 0xA001
                else:
                    crc >>= 1
        return crc
    
    def _send_command(self, function_code: int, register: int, value: int) -> bool:
        """Send MODBUS RTU command"""
        if not self.serial_port or not self.serial_port.is_open:
            log.error("Serial port not open")
            return False
        
        # Build MODBUS frame: [address][function][register_hi][register_lo][value_hi][value_lo]
        frame = bytearray([
            self.address,
            function_code,
            (register >> 8) & 0xFF,
            register & 0xFF,
            (value >> 8) & 0xFF,
            value & 0xFF
        ])
        
        # Add CRC
        crc = self._calculate_crc(frame)
        frame.append(crc & 0xFF)
        frame.append((crc >> 8) & 0xFF)
        
        try:
            self.serial_port.write(frame)
            time.sleep(0.05)  # Small delay for response
            
            # Read response (8 bytes for typical MODBUS response)
            response = self.serial_port.read(8)
            if len(response) >= 6:
                # Verify response address and function code
                if response[0] == self.address and response[1] == function_code:
                    return True
            return False
        except Exception as e:
            log.error(f"Command failed: {e}")
            return False
    
    def set_rpm(self, rpm: int) -> bool:
        """
        Set motor RPM (signed, negative = reverse)
        Register 0x2000 is typical for speed command in many controllers
        Adjust register based on your specific controller documentation
        """
        # Clamp RPM to 16-bit signed range
        rpm = max(-32767, min(32767, rpm))
        
        # Convert to unsigned for transmission (two's complement if negative)
        if rpm < 0:
            value = (1 << 16) + rpm
        else:
            value = rpm
        
        # MODBUS function 0x06 = Write Single Register
        return self._send_command(0x06, 0x2000, value)
    
    def enable_motor(self) -> bool:
        """Enable motor drive"""
        # Register 0x2001 for enable (typical, adjust as needed)
        return self._send_command(0x06, 0x2001, 0x0001)
    
    def disable_motor(self) -> bool:
        """Disable motor drive"""
        return self._send_command(0x06, 0x2001, 0x0000)
    
    def read_status(self) -> Optional[Dict]:
        """Read motor status (actual RPM, errors, etc.)"""
        # This would read multiple registers
        # Implementation depends on controller's register map
        # Placeholder for now
        return {
            "connected": self.connected,
            "enabled": False,
            "actual_rpm": 0,
            "error": 0
        }


class MotorManager:
    """Manages multiple motor controller instances"""
    
    def __init__(self):
        self.motors: Dict[int, RattmotorYPMC] = {}
        self.configs: Dict[int, Dict] = {}
    
    def add_motor(self, index: int, config: Dict):
        """Add/update a motor controller"""
        port = config.get("port", "COM1")
        baudrate = config.get("baudrate", 9600)
        address = config.get("address", 1)
        
        # Disconnect old instance if exists
        if index in self.motors:
            self.motors[index].disconnect()
        
        # Create new instance
        motor = RattmotorYPMC(port, baudrate, address)
        self.motors[index] = motor
        self.configs[index] = config
        
        # Try to connect
        motor.connect()
        
        return motor
    
    def remove_motor(self, index: int):
        """Remove a motor controller"""
        if index in self.motors:
            self.motors[index].disconnect()
            del self.motors[index]
            del self.configs[index]
    
    def set_motor_rpm(self, index: int, rpm: float, cw_positive: bool = True):
        """Set motor RPM with direction"""
        if index not in self.motors:
            log.error(f"Motor {index} not found")
            return False
        
        motor = self.motors[index]
        config = self.configs[index]
        
        # Apply min/max limits
        min_rpm = config.get("min_rpm", 0)
        max_rpm = config.get("max_rpm", 2500)
        
        # Clamp to limits
        if rpm >= 0:
            rpm = min(max_rpm, max(min_rpm, rpm))
        else:
            rpm = max(-max_rpm, min(-min_rpm, rpm))
        
        # Apply direction polarity
        if not cw_positive:
            rpm = -rpm
        
        return motor.set_rpm(int(rpm))
    
    def update_motor_from_input(self, index: int, input_value: float):
        """Update motor speed based on scaled input value"""
        if index not in self.motors:
            return False
        
        config = self.configs[index]
        scale = config.get("scale_factor", 250.0)  # default: 0-10V -> 0-2500 RPM
        offset = config.get("offset", 0.0)
        cw_positive = config.get("cw_positive", True)
        
        # Calculate RPM: rpm = input * scale + offset
        rpm = input_value * scale + offset
        
        return self.set_motor_rpm(index, rpm, cw_positive)
    
    def get_motor_status(self, index: int) -> Optional[Dict]:
        """Get motor status"""
        if index in self.motors:
            return self.motors[index].read_status()
        return None
    
    def disconnect_all(self):
        """Disconnect all motors"""
        for motor in self.motors.values():
            motor.disconnect()


def list_serial_ports() -> List[Dict[str, str]]:
    """List available COM ports"""
    ports = []
    for port in serial.tools.list_ports.comports():
        ports.append({
            "port": port.device,
            "description": port.description,
            "hwid": port.hwid
        })
    return ports
