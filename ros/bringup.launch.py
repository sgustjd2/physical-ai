"""전체 기동: rosbridge(웹소켓 :9090) + 워크플로 실행기 + (mock:=true면) 모의 로봇팔.

실제 팔 예시:
  ros2 launch bringup.launch.py mock:=false \
    trajectory_action:=/joint_trajectory_controller/follow_joint_trajectory \
    joints:="[shoulder_pan_joint, shoulder_lift_joint, elbow_joint, wrist_1_joint, wrist_2_joint, wrist_3_joint]"
"""
import os

from ament_index_python.packages import get_package_share_directory
from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument, ExecuteProcess, IncludeLaunchDescription
from launch.conditions import IfCondition
from launch.launch_description_sources import AnyLaunchDescriptionSource
from launch.substitutions import LaunchConfiguration

HERE = os.path.dirname(os.path.abspath(__file__))


def script(name, *params, **kw):
    cmd = ['python3', os.path.join(HERE, name), '--ros-args']
    for p in params:
        cmd += ['-p', [f'{p}:=', LaunchConfiguration(p)]]
    return ExecuteProcess(cmd=cmd, output='screen', name=name, **kw)


def generate_launch_description():
    rosbridge = os.path.join(get_package_share_directory('rosbridge_server'),
                             'launch', 'rosbridge_websocket_launch.xml')
    return LaunchDescription([
        DeclareLaunchArgument('mock', default_value='true'),
        DeclareLaunchArgument('joints', default_value='[joint1, joint2, joint3, joint4, joint5, joint6]'),
        DeclareLaunchArgument('trajectory_action', default_value='/arm_controller/follow_joint_trajectory'),
        IncludeLaunchDescription(AnyLaunchDescriptionSource(rosbridge)),
        script('workflow_executor.py', 'joints', 'trajectory_action'),
        script('mock_arm.py', 'joints', condition=IfCondition(LaunchConfiguration('mock'))),
    ])
