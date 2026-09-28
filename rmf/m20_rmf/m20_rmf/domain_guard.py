"""Keep Jazzy off the robots' DDS domain.

The robots' relays are Foxy (Fast DDS 2.1). As soon as a Jazzy participant can reach
them on the same ROS_DOMAIN_ID, every relay dies with "Deserialization of data
failed" -> std::bad_alloc (seen on robot 834, 2026-09-28; almost certainly the
/parameter_events every Jazzy node publishes on start-up). Open-RMF therefore runs on
its own domain and talks to the robots only over the vendor UDP API.
"""

import os
import sys

ROBOT_DOMAIN = '0'


def check(allow_flag='--allow-robot-domain', argv=None):
    """Exit if running on the robots' domain, unless allow_flag is in argv."""
    argv = sys.argv if argv is None else argv
    domain = os.environ.get('ROS_DOMAIN_ID', '0') or '0'
    if domain == ROBOT_DOMAIN and allow_flag not in argv:
        sys.exit(
            f'ROS_DOMAIN_ID={domain} is the robots\' domain. A Jazzy participant there '
            'crashes the Foxy relays on the robots (bad_alloc). Use the RMF domain '
            '(export ROS_DOMAIN_ID=10), or pass ' + allow_flag + ' if no Foxy relay '
            'can see this machine.')
    if allow_flag in argv:
        argv.remove(allow_flag)
