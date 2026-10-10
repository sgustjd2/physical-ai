"""전체 기동. 로봇 프로파일(robots/<robot>/robot.yaml)을 읽어 필요한 것만 띄운다.

  ros2 launch bringup.launch.py robot:=demo_arm

  항상: rosbridge(웹소켓 :9090), 워크플로 실행기·저장소, 에피소드 녹화기,
        디지털 트윈 팔(/sim — 시뮬레이션 실행용, 쉬는 동안 실제 자세를 따라감)
  mock: true 이면 모의 팔, urdf 가 있으면 robot_state_publisher(/robot_description, /tf)
"""
import json
import os
from pathlib import Path

import yaml
from ament_index_python.packages import get_package_share_directory
from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument, ExecuteProcess, IncludeLaunchDescription, OpaqueFunction
from launch.launch_description_sources import AnyLaunchDescriptionSource
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import Node

HERE = Path(__file__).resolve().parent
ROBOTS = Path(os.environ.get('ROBOTS_DIR', HERE.parent / 'robots'))


def script(name, ros_args=(), label=None, **params):
    cmd = ['python3', str(HERE / name), '--ros-args', *ros_args]
    for k, v in params.items():
        cmd += ['-p', f'{k}:={json.dumps(v)}']  # JSON은 YAML로도 유효 → 리스트·문자열이 그대로 전달됨
    return ExecuteProcess(cmd=cmd, output='screen', name=label or name)


def setup(context):
    robot = LaunchConfiguration('robot').perform(context)
    profile = ROBOTS / robot / 'robot.yaml'
    if not profile.exists():
        have = sorted(p.parent.name for p in ROBOTS.glob('*/robot.yaml'))
        raise RuntimeError(f'로봇 프로파일 없음: {profile} (있는 것: {have})')
    cfg = yaml.safe_load(profile.read_text(encoding='utf-8'))

    executor = {'joints': cfg['joints'], 'trajectory_action': cfg['trajectory_action']}
    if cfg.get('gripper_topic'):
        executor['gripper_topic'] = cfg['gripper_topic']
    actions = [
        script('workflow_executor.py', **executor),
        script('workflow_store.py'),
        script('recorder.py', topics=cfg.get('record_topics', ['/joint_states']), robot=robot),
        script('mock_arm.py', ros_args=['-r', '__ns:=/sim', '-r', '__node:=sim_arm'], label='sim_arm',
               joints=cfg['joints'], mirror_topic='/joint_states'),
    ]
    if cfg.get('mock'):
        actions.append(script('mock_arm.py', joints=cfg['joints']))
    if cfg.get('urdf'):
        urdf = (profile.parent / cfg['urdf']).read_text(encoding='utf-8')
        actions.append(Node(package='robot_state_publisher', executable='robot_state_publisher',
                            parameters=[{'robot_description': urdf}]))
    return actions


def generate_launch_description():
    rosbridge = os.path.join(get_package_share_directory('rosbridge_server'),
                             'launch', 'rosbridge_websocket_launch.xml')
    return LaunchDescription([
        DeclareLaunchArgument('robot', default_value='demo_arm', description='robots/ 아래 프로파일 이름'),
        IncludeLaunchDescription(AnyLaunchDescriptionSource(rosbridge)),
        OpaqueFunction(function=setup),
    ])
