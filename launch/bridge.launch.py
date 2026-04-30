from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument, OpaqueFunction, ExecuteProcess
from launch.substitutions import LaunchConfiguration


def _launch(context, *args, **kwargs):
    ip    = context.perform_substitution(LaunchConfiguration("robot_ip"))
    queue = context.perform_substitution(LaunchConfiguration("queue"))
    cmd   = ["ros2", "run", "nav_cmd_bridge", "nav_cmd_bridge", "bridge"]
    if queue == "true":
        cmd.append("queue")
    cmd += ["--ip", ip]
    return [ExecuteProcess(cmd=cmd, output="screen", emulate_tty=True)]


def generate_launch_description():
    return LaunchDescription([
        DeclareLaunchArgument("robot_ip", default_value="10.21.31.103",
                              description="Robot IP address"),
        DeclareLaunchArgument("queue", default_value="false",
                              description="true = queue mode (collect goals, execute on ENTER)"),
        OpaqueFunction(function=_launch),
    ])
