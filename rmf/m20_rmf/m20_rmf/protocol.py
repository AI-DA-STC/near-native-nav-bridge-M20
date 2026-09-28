"""DeepRobotics M20 UDP command protocol.

Python port of the framing and commands in src/nav_bridge_node.cpp; keep the two in
sync. Only commands that the C++ bridge already exercises on real robots live here —
the vendor protocol has more, but unverified codes are deliberately not guessed at.

Packet: 16-byte header + JSON payload, sent to <robot_ip>:30000.
  header[0:4] = eb 91 eb 90   magic
  header[4:6] = payload length, little endian
  header[6:8] = message id, little endian
  header[8]   = 0x01          JSON payload
"""

import json
import struct

PORT = 30000
HEADER_LEN = 16
MAGIC = bytes([0xEB, 0x91, 0xEB, 0x90])

# Every command the bridge sends carries this fixed timestamp; the robot ignores it.
_TIME = '2025-01-01 00:00:00'

NAV_ERRORS = {
    0: 'OK',
    0x2300: 'Cancelled',
    0x2302: 'Success',
    0xA301: 'Abnormal motion state',
    0xA302: 'Battery too low',
    0xA303: 'Motor overtemperature',
    0xA312: 'Nav module comms abnormal',
    0xA313: 'Location abnormal',
    0xA328: 'Failed to switch nav mode',
    0xA341: 'Already executing task',
    0xA34B: 'Persistent obstacle stop',
    0xA34C: 'Global planning failure',
    57351: 'No operation permission',
}

NAV_STATUS = {0: 'Idle', 2: 'Preprocessing', 3: 'Navigating', 4: 'Complete', 0xFF: 'Paused'}
STATUS_COMPLETE = 4

# Errors after which re-sending the same goal is pointless until a human intervenes.
FATAL_ERRORS = {0xA301, 0xA302, 0xA303, 0xA313, 57351}

# Defaults for a navigation goal, as used by the bridge (Gait 12290 = the walking
# gait the team validated; Speed 1 = normal; ObsMode 0 = obstacle avoidance on).
NAV_DEFAULTS = {'gait': 12290, 'speed': 1, 'manner': 0, 'obs_mode': 0, 'nav_mode': 1}


def _cmd(type_, command, items=None):
    return {'PatrolDevice': {'Type': type_, 'Command': command, 'Time': _TIME,
                             'Items': items or {}}}


def heartbeat():
    return _cmd(100, 100)


def nav_mode():
    """Switch the robot into navigation mode; the bridge sends it before each goal."""
    return _cmd(1101, 5, {'Mode': 1})


def nav_goal(value, x, y, yaw, gait=None, speed=None, manner=None, obs_mode=None,
             nav_mode_=None, map_id=0):
    d = NAV_DEFAULTS
    return _cmd(1003, 1, {
        'Value': int(value), 'MapID': map_id,
        'PosX': float(x), 'PosY': float(y), 'PosZ': 0.0, 'AngleYaw': float(yaw),
        'PointInfo': 1,
        'Gait': d['gait'] if gait is None else int(gait),
        'Speed': d['speed'] if speed is None else int(speed),
        'Manner': d['manner'] if manner is None else int(manner),
        'ObsMode': d['obs_mode'] if obs_mode is None else int(obs_mode),
        'NavMode': d['nav_mode'] if nav_mode_ is None else int(nav_mode_),
    })


def cancel_nav():
    return _cmd(1004, 1)


def stand_up():
    return _cmd(2, 2, {'MotionParam': 1})


def estop():
    return _cmd(2, 22, {'MotionParam': 2})


def encode(payload, msg_id):
    body = json.dumps(payload, separators=(',', ':')).encode()
    header = bytearray(HEADER_LEN)
    header[0:4] = MAGIC
    header[4:6] = struct.pack('<H', len(body))
    header[6:8] = struct.pack('<H', msg_id & 0xFFFF)
    header[8] = 0x01
    return bytes(header) + body


def decode(packet):
    """Return the JSON payload of a packet as a dict, or None if it is not one."""
    if len(packet) <= HEADER_LEN:
        return None
    body = packet[HEADER_LEN:]
    try:
        return json.loads(body.decode(errors='replace').rstrip('\x00'))
    except ValueError:
        return None


class Response:
    """Flattened view of a robot reply: type, command and the Items fields."""

    def __init__(self, payload):
        dev = payload.get('PatrolDevice', payload) if isinstance(payload, dict) else {}
        self._dev = dev = dev if isinstance(dev, dict) else {}
        self.type = _int(dev.get('Type'))
        self.command = _int(dev.get('Command'))
        items = dev.get('Items') or {}
        self.items = items if isinstance(items, dict) else {}
        # Some firmware puts fields at the top level; the C++ parser searched the whole
        # payload for the key, so do the same.
        self.error = _int(self._field('ErrorCode'))
        self.status = _int(self._field('Status'))
        self.value = _int(self._field('Value'))

    def _field(self, key):
        if key in self.items:
            return self.items[key]
        return self._dev.get(key)

    # Periodic status the robot streams (Type 1002) once it receives heartbeats.
    # Observed on a real M20 (fw "PRO"): cmd 3 ErrorList, 4 MotionStatus/MotorStatus,
    # 5 BatteryStatus, 6 BasicStatus, 7 NavStatus + LocationStatus.
    @property
    def status_kind(self):
        if self.type != 1002:
            return None
        return {3: 'errors', 4: 'motion', 5: 'battery', 6: 'basic', 7: 'location'}.get(self.command)

    @property
    def is_nav_ack(self):
        return self.type == 1003 and self.command == 1

    @property
    def is_nav_status(self):
        return self.type == 1007 and self.command == 1

    def describe(self):
        if self.is_nav_ack:
            return f'nav ack: {error_str(self.error)}'
        if self.is_nav_status:
            return (f'nav status: point={self.value} {NAV_STATUS.get(self.status, "Unknown")}'
                    f' error={error_str(self.error)}')
        return f'type={self.type} cmd={self.command} items={self.items}'


def error_str(code):
    return NAV_ERRORS.get(code, f'Unknown error {code}') if code is not None else 'n/a'


def _int(v):
    try:
        return int(v)
    except (TypeError, ValueError):
        return None
