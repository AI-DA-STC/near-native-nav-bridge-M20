"""Task-state monitor: the websocket endpoint RMF reports to, republished on ROS.

The fleet adapter and dispatcher push task/fleet state as JSON over a websocket
(`server_uri`) instead of ROS topics. In a full deployment rmf-web's api-server
receives those; this node is the minimal stand-in so missions and the CLI can track
tasks without the web stack:

  ws://0.0.0.0:7878   <- {"type": "task_state_update" | "task_log_update" |
                            "fleet_state_update" | "fleet_log_update", "data": {...}}
  pub /m20/task_states   std_msgs/String  one task state JSON per update
  pub /m20/fleet_state   std_msgs/String  latest fleet state JSON

Pointing server_uri at rmf-web instead later needs no change elsewhere except the
mission runner's task tracking source.
"""

import argparse
import asyncio
import json
import sys
import threading

import rclpy
import rclpy.node
from rclpy.qos import QoSProfile, DurabilityPolicy, ReliabilityPolicy
from std_msgs.msg import String
import websockets


def main(argv=sys.argv):
    from . import domain_guard
    domain_guard.check(argv=argv)
    rclpy.init(args=argv)
    args_ = rclpy.utilities.remove_ros_args(argv)
    p = argparse.ArgumentParser(prog='m20_monitor')
    p.add_argument('--port', type=int, default=7878)
    a = p.parse_args(args_[1:])

    node = rclpy.node.Node('m20_task_monitor')
    latched = QoSProfile(depth=100, reliability=ReliabilityPolicy.RELIABLE,
                         durability=DurabilityPolicy.TRANSIENT_LOCAL)
    task_pub = node.create_publisher(String, '/m20/task_states', latched)
    fleet_pub = node.create_publisher(String, '/m20/fleet_state', 10)
    log = node.get_logger()
    last_status = {}

    async def handler(ws, path=None):
        async for raw in ws:
            try:
                msg = json.loads(raw)
            except ValueError:
                continue
            kind, data = msg.get('type'), msg.get('data') or {}
            if kind == 'task_state_update':
                task_pub.publish(String(data=json.dumps(data)))
                tid = (data.get('booking') or {}).get('id')
                status = data.get('status')
                if tid and last_status.get(tid) != status:
                    last_status[tid] = status
                    who = (data.get('assigned_to') or {}).get('name', '?')
                    log.info(f'task {tid} [{who}] -> {status}')
            elif kind == 'fleet_state_update':
                fleet_pub.publish(String(data=json.dumps(data)))

    async def serve():
        async with websockets.serve(handler, '0.0.0.0', a.port, max_size=None):
            log.info(f'listening for RMF task/fleet state on ws://0.0.0.0:{a.port}')
            await asyncio.Future()

    threading.Thread(target=lambda: asyncio.run(serve()), daemon=True).start()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    rclpy.try_shutdown()


if __name__ == '__main__':
    main()
