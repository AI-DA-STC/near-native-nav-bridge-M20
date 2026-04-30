import os
from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument, OpaqueFunction, ExecuteProcess
from launch.substitutions import LaunchConfiguration

_PKG_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _launch(context, *args, **kwargs):
    test      = context.perform_substitution(LaunchConfiguration("test"))
    map_name  = context.perform_substitution(LaunchConfiguration("map"))
    waypoints = context.perform_substitution(LaunchConfiguration("waypoints"))
    trials    = context.perform_substitution(LaunchConfiguration("trials"))
    ip        = context.perform_substitution(LaunchConfiguration("robot_ip"))
    out_dir   = context.perform_substitution(LaunchConfiguration("output_dir"))

    script = os.path.join(_PKG_DIR, "scripts", "benchmark.py")
    cmd = ["python3", script, test, "--map", map_name, "--ip", ip]
    if waypoints:
        cmd += ["--waypoints", waypoints]
    if trials:
        cmd += ["--trials", trials]
    if out_dir:
        cmd += ["--output-dir", out_dir]
    return [ExecuteProcess(cmd=cmd, output="screen", emulate_tty=True)]


def generate_launch_description():
    return LaunchDescription([
        DeclareLaunchArgument("test",       description="Test type: T1 | T2 | T3 | T4"),
        DeclareLaunchArgument("map",        description="Map name used during testing"),
        DeclareLaunchArgument("waypoints",  default_value="",
                              description="Path to waypoints CSV (x,y[,yaw_rad] per line). T2/T3/T4 only."),
        DeclareLaunchArgument("trials",     default_value="",
                              description="Number of trials (default: 5 for T1, 1 for T2-T4)"),
        DeclareLaunchArgument("robot_ip",   default_value="10.21.31.103",
                              description="Robot IP address"),
        DeclareLaunchArgument("output_dir", default_value="",
                              description="Output directory for CSVs/Excel (default: assets/outputs/<timestamp>)"),
        OpaqueFunction(function=_launch),
    ])
