"""Keep the RMF stack off domain 0.

Domain 0 is where the robots' own DeepRobotics nodes live and where other people's
relays and tools run. Open-RMF works on the laptop domain the robots' relays publish
to (LAPTOP_DOMAIN_ID on the robot, 20 for 834 in the lab), never on 0.

History: on 2026-09-28 the Foxy relays on 834 died with "Deserialization of data
failed" -> std::bad_alloc while reachable on domain 0, at first blamed on Jazzy
participants. A controlled test (Foxy relays + the full Jazzy RMF stack, ros2 daemon,
topic hz/echo on one spare domain) did not reproduce it, so Jazzy<->Foxy on the same
domain is fine; the likelier culprit is domain-0 traffic from other robots, whose
internal networks use identical addresses. Either way RMF has no business on 0.
"""

import os
import sys

ROBOT_DOMAIN = '0'


def check(allow_flag='--allow-robot-domain', argv=None):
    """Exit if running on domain 0, unless allow_flag is in argv."""
    argv = sys.argv if argv is None else argv
    domain = os.environ.get('ROS_DOMAIN_ID', '0') or '0'
    if domain == ROBOT_DOMAIN and allow_flag not in argv:
        sys.exit(
            f'ROS_DOMAIN_ID={domain} is the robots\' internal / shared domain. Run Open-RMF on '
            'the laptop domain the relays publish to (e.g. export ROS_DOMAIN_ID=20), or pass '
            + allow_flag + ' if you really mean domain 0.')
    if allow_flag in argv:
        argv.remove(allow_flag)
