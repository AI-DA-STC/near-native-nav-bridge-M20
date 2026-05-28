"""
Laptop-side single-robot launch.

Thin wrapper around multirobot.launch.py with a one-entry fleet.

Usage:
    ros2 launch nav_cmd_bridge bridge.launch.py \
        robot_name:=robot_741 robot_ip:=192.168.8.101

    # queue mode (collect arrows in RViz, ENTER to execute)
    ros2 launch nav_cmd_bridge bridge.launch.py \
        robot_name:=robot_741 robot_ip:=192.168.8.101 queue:=true
"""
import os

from ament_index_python.packages import get_package_share_directory
from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument, IncludeLaunchDescription
from launch.launch_description_sources import PythonLaunchDescriptionSource
from launch.substitutions import LaunchConfiguration, TextSubstitution


def generate_launch_description():
    multirobot_launch = os.path.join(
        get_package_share_directory("nav_cmd_bridge"),
        "launch", "multirobot.launch.py")

    robots_expr = [
        LaunchConfiguration("robot_name"),
        TextSubstitution(text=":"),
        LaunchConfiguration("robot_ip"),
    ]

    return LaunchDescription([
        DeclareLaunchArgument("robot_name", default_value="robot_741",
                              description="Per-robot namespace, e.g. robot_741"),
        DeclareLaunchArgument("robot_ip",   default_value="192.168.8.101",
                              description="Robot IP address"),
        DeclareLaunchArgument("queue",      default_value="false",
                              description="true = queue mode (collect goals, execute on ENTER)"),
        IncludeLaunchDescription(
            PythonLaunchDescriptionSource(multirobot_launch),
            launch_arguments={
                "robots": robots_expr,
                "queue":  LaunchConfiguration("queue"),
            }.items(),
        ),
    ])
