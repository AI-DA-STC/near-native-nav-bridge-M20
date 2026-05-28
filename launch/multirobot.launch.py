"""
Laptop-side multi-robot launch.

For each robot in the fleet config, spawns:
  * tf relays that fan in /<robot_name>/{tf,tf_static}_relayed onto the shared
    /tf and /tf_static so RViz sees one unified tf tree.
  * a nav_cmd_bridge `bridge` instance inside that robot's namespace; it
    subscribes to /<robot_name>/goal_pose and /<robot_name>/ODOM_relayed and
    sends UDP waypoint commands to the robot's IP.

Frame layout after all robots are up:
    map
    ├── robot_741/odom -> robot_741/base_link
    ├── robot_738/odom -> robot_738/base_link
    └── robot_665/odom -> robot_665/base_link

To target a specific robot from RViz, set the 2D Goal Pose tool's topic to
/<robot_name>/goal_pose (one tool per robot, or switch via RViz tool config).

Usage:
    # default fleet (defined in DEFAULT_FLEET below)
    ros2 launch nav_cmd_bridge multirobot.launch.py

    # custom fleet
    ros2 launch nav_cmd_bridge multirobot.launch.py \
        robots:=robot_741:192.168.8.101,robot_738:192.168.8.102

    # queue mode for all robots (collect arrows, ENTER to execute per robot)
    ros2 launch nav_cmd_bridge multirobot.launch.py queue:=true
"""
from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument, OpaqueFunction
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import Node


# name -> IP. Override at launch time with the `robots` arg.
DEFAULT_FLEET = [
    ("robot_741", "192.168.8.101"),
    ("robot_738", "192.168.8.102"),
    ("robot_665", "192.168.8.103"),
]


def _parse_fleet(spec: str):
    """Parse 'name1:ip1,name2:ip2' into [(name, ip), ...]. Empty -> DEFAULT_FLEET."""
    if not spec:
        return DEFAULT_FLEET
    out = []
    for entry in spec.split(","):
        entry = entry.strip()
        if not entry:
            continue
        if ":" not in entry:
            raise RuntimeError(f"bad robot spec '{entry}', expected name:ip")
        name, ip = entry.split(":", 1)
        out.append((name.strip(), ip.strip()))
    if not out:
        raise RuntimeError("`robots` arg parsed to empty fleet")
    return out


def _per_robot_nodes(robot_name: str, robot_ip: str, queue: bool):
    """Nodes needed on the laptop side to talk to one robot."""
    nodes = []

    # Fan-in: /<robot_name>/tf_relayed -> /tf (the robot has already prefixed frame_ids).
    nodes.append(Node(
        package='nav_cmd_bridge',
        executable='tfmessage_relay',
        namespace=robot_name,
        name='tf_fanin',
        output='screen',
        parameters=[{
            'input_topic':  'tf_relayed',   # /<robot_name>/tf_relayed
            'output_topic': '/tf',          # absolute: shared /tf for RViz
        }],
    ))
    nodes.append(Node(
        package='nav_cmd_bridge',
        executable='tfmessage_relay',
        namespace=robot_name,
        name='tf_static_fanin',
        output='screen',
        parameters=[{
            'input_topic':  'tf_static_relayed',
            'output_topic': '/tf_static',
            'durability':   'transient_local',
        }],
    ))

    # nav_cmd_bridge in `bridge` mode, namespaced. Subscribes to
    # <robot_name>/{goal_pose, ODOM_relayed} and sends UDP to robot_ip.
    bridge_args = ['bridge']
    if queue:
        bridge_args.append('queue')
    bridge_args += ['--ip', robot_ip]
    nodes.append(Node(
        package='nav_cmd_bridge',
        executable='nav_cmd_bridge',
        namespace=robot_name,
        name='goal_bridge',
        output='screen',
        emulate_tty=True,
        arguments=bridge_args,
    ))

    return nodes


def _launch(context, *args, **kwargs):
    robots_spec = context.perform_substitution(LaunchConfiguration("robots"))
    queue_str   = context.perform_substitution(LaunchConfiguration("queue"))
    queue       = queue_str.lower() == "true"

    fleet = _parse_fleet(robots_spec)

    nodes = []
    for name, ip in fleet:
        print(f"[multirobot] {name} -> {ip} (queue={queue})")
        nodes.extend(_per_robot_nodes(name, ip, queue))
    return nodes


def generate_launch_description():
    return LaunchDescription([
        DeclareLaunchArgument(
            "robots",
            default_value="",
            description="Comma-separated fleet: name1:ip1,name2:ip2,... "
                        "Empty uses the default fleet defined in the launch file."),
        DeclareLaunchArgument(
            "queue",
            default_value="false",
            description="true = queue mode per robot (collect arrows, ENTER to execute)"),
        OpaqueFunction(function=_launch),
    ])
