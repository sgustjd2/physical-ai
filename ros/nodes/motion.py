"""팔 동작 노드. 표준 FollowJointTrajectory 액션을 쓰므로 ros2_control 기반 팔이면 그대로 동작한다."""
import math

from action_msgs.msg import GoalStatus
from builtin_interfaces.msg import Duration
from control_msgs.action import FollowJointTrajectory
from rclpy.action import ActionClient
from trajectory_msgs.msg import JointTrajectory, JointTrajectoryPoint

from nodes import field, node

GROUP = '동작'
ICON = 'arm'
ORDER = 1
SIM_ACTION = '/sim/arm_controller/follow_joint_trajectory'  # 트윈 팔 (bringup이 /sim 에 띄움)


def setup(ctx):
    action = ctx.param('trajectory_action', '/arm_controller/follow_joint_trajectory')
    ctx.arm = ActionClient(ctx, FollowJointTrajectory, action)
    ctx.sim_arm = ActionClient(ctx, FollowJointTrajectory, SIM_ACTION)
    # 명령도 녹화되도록 발행 (학습 데이터의 action). 녹화 시작 전에 토픽이 있어야 하므로 미리 만든다
    ctx.cmd_pub = ctx.create_publisher(JointTrajectory, '/workflow/command', 10)
    ctx.sim_cmd_pub = ctx.create_publisher(JointTrajectory, '/sim/workflow/command', 10)


@node('move_j', 'MoveJ 관절 이동', desc='티칭한 자세(관절 각도)로 팔을 움직입니다', fields=[
    field('joints', '관절 각도 (°)', 'joints'),
    field('duration', '이동 시간 (s)', 'number', 2),
])
def move_j(ctx, d):
    move(ctx, d['joints'], float(d.get('duration') or 2))


@node('move_home', '홈 위치로 이동', desc='로봇 프로파일에 정한 홈 자세로 돌아갑니다', fields=[
    field('duration', '이동 시간 (s)', 'number', 3),
])
def move_home(ctx, d):
    move(ctx, ctx.home, float(d.get('duration') or 3))


def move(ctx, degrees, duration):
    positions = [math.radians(float(v)) for v in degrees]
    if len(positions) != len(ctx.joints):
        raise ValueError(f'조인트 값 {len(positions)}개, 필요 {len(ctx.joints)}개')
    # 시뮬레이션 실행이면 실제 팔은 그대로 두고 트윈 팔만 움직인다
    arm, pub = (ctx.sim_arm, ctx.sim_cmd_pub) if ctx.sim else (ctx.arm, ctx.cmd_pub)
    if not arm.wait_for_server(timeout_sec=2):
        raise RuntimeError('시뮬레이션 팔 응답 없음' if ctx.sim else '로봇팔 액션 서버 응답 없음')

    traj = JointTrajectory(joint_names=ctx.joints, points=[JointTrajectoryPoint(
        positions=positions, time_from_start=Duration(sec=int(duration), nanosec=int(duration % 1 * 1e9)))])
    traj.header.stamp = ctx.get_clock().now().to_msg()
    pub.publish(traj)

    future = arm.send_goal_async(FollowJointTrajectory.Goal(trajectory=traj))
    try:
        ctx.wait_until(future.done)
    except Exception:
        # 수락 응답 전에 정지되면, 나중에 수락되는 즉시 취소 (그냥 두면 목표가 끝까지 실행됨)
        future.add_done_callback(lambda f: f.result().accepted and f.result().cancel_goal_async())
        raise
    handle = future.result()
    if not handle.accepted:
        raise RuntimeError('로봇팔이 목표를 거부함')
    future = handle.get_result_async()
    try:
        ctx.wait_until(future.done)
    except Exception:
        handle.cancel_goal_async()  # 소프트웨어 정지일 뿐, 비상정지(E-stop)를 대신하지 않는다
        raise
    res = future.result()
    if res.status != GoalStatus.STATUS_SUCCEEDED or res.result.error_code != 0:
        raise RuntimeError(res.result.error_string or f'이동 실패 (status={res.status})')
