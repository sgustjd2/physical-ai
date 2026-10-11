"""팔 동작 노드. 표준 FollowJointTrajectory 액션을 쓰므로 ros2_control 기반 팔이면 그대로 동작한다."""
import json
import math
from pathlib import Path

from action_msgs.msg import GoalStatus
from builtin_interfaces.msg import Duration
from control_msgs.action import FollowJointTrajectory
from rclpy.action import ActionClient
from rclpy.qos import DurabilityPolicy, QoSProfile
from sensor_msgs.msg import JointState
from std_msgs.msg import String
from trajectory_msgs.msg import JointTrajectory, JointTrajectoryPoint

from nodes import field, node

GROUP = '동작'
ICON = 'arm'
ORDER = 1
SIM_ACTION = '/sim/arm_controller/follow_joint_trajectory'  # 트윈 팔 (bringup이 /sim 에 띄움)
DATASETS = Path(__file__).resolve().parents[2] / 'data' / 'lerobot'  # ai/convert_lerobot.py 결과 (컨테이너에선 /data/lerobot)
LEAD_SPEED = 0.5  # rad/s: 녹화 동작 재생 전 첫 자세로 다가가는 속도 상한 (어디서 시작하든 천천히)


def setup(ctx):
    action = ctx.param('trajectory_action', '/arm_controller/follow_joint_trajectory')
    ctx.arm = ActionClient(ctx, FollowJointTrajectory, action)
    ctx.sim_arm = ActionClient(ctx, FollowJointTrajectory, SIM_ACTION)
    # 명령도 녹화되도록 발행 (학습 데이터의 action). 녹화 시작 전에 토픽이 있어야 하므로 미리 만든다
    ctx.cmd_pub = ctx.create_publisher(JointTrajectory, '/workflow/command', 10)
    ctx.sim_cmd_pub = ctx.create_publisher(JointTrajectory, '/sim/workflow/command', 10)
    # 지금 자세 (녹화 동작 재생이 첫 자세까지 얼마나 천천히 갈지 정하는 데 씀)
    ctx.joint_now = {'real': {}, 'sim': {}}
    ctx.create_subscription(JointState, '/joint_states', lambda m: ctx.joint_now['real'].update(zip(m.name, m.position)), 10)
    ctx.create_subscription(JointState, '/sim/joint_states', lambda m: ctx.joint_now['sim'].update(zip(m.name, m.position)), 10)
    publish_datasets(ctx)


def publish_datasets(ctx):
    """재생할 수 있는 데이터셋 목록 → /workflow/datasets (latched) [{name, episodes: [{index, task, seconds}]}].
    웹의 '녹화 동작 재생' 블록이 드롭다운으로 쓴다. 5초마다 훑고 바뀌었을 때만 보낸다 (파일은 바뀐 것만 다시 읽음)."""
    pub = ctx.create_publisher(String, '/workflow/datasets', QoSProfile(depth=1, durability=DurabilityPolicy.TRANSIENT_LOCAL))
    cache, last = {}, [None]

    def scan():
        out = []
        for d in sorted(DATASETS.glob('*/replay')):
            eps = []
            for p in sorted(d.glob('episode_*.json')):
                try:
                    mtime = p.stat().st_mtime
                    if cache.get(p, (None,))[0] != mtime:
                        r = json.loads(p.read_text(encoding='utf-8'))
                        cache[p] = (mtime, {'index': int(p.stem.rsplit('_', 1)[1]), 'task': r.get('task', ''),
                                            'seconds': round(len(r.get('actions', [])) / (r.get('fps') or 30), 1)})
                except (OSError, ValueError):
                    continue
                eps.append(cache[p][1])
            if eps:
                out.append({'name': d.parent.name, 'episodes': eps})
        data = json.dumps(out, ensure_ascii=False)
        if data != last[0]:
            last[0] = data
            pub.publish(String(data=data))

    scan()
    ctx.create_timer(5.0, scan)


@node('move_j', 'MoveJ 관절 이동', desc='티칭한 자세(관절 각도)로 팔을 움직입니다', resource='arm', fields=[
    field('joints', '관절 각도 (°)', 'joints'),
    field('duration', '이동 시간 (s)', 'number', 2),
])
def move_j(ctx, d):
    move(ctx, d['joints'], float(d.get('duration') or 2))


@node('move_home', '홈 위치로 이동', desc='로봇 프로파일에 정한 홈 자세로 돌아갑니다', resource='arm', fields=[
    field('duration', '이동 시간 (s)', 'number', 3),
])
def move_home(ctx, d):
    move(ctx, ctx.home, float(d.get('duration') or 3))


@node('play_episode', '녹화 동작 재생', resource='arm',
      desc='학습 데이터셋으로 변환한 시연 동작을 그대로 다시 움직입니다 (시뮬레이션이면 트윈에서 확인)', fields=[
          field('dataset', '데이터셋', 'dataset', ''),
          field('episode', '에피소드', 'episode', 0),
          field('speed', '재생 속도 (배)', 'number', 1, advanced=True),
      ])
def play_episode(ctx, d):
    """check_dataset.py 가 점검을 통과한 데이터셋에 남긴 궤적(replay/episode_NNN.json, 학습 데이터의 action)을 재생한다.
    첫 자세까지는 LEAD_SPEED 이하로 천천히 가고, 그다음은 녹화 속도(×speed) 그대로."""
    name = str(d.get('dataset') or '').strip()
    ep = int(float(d.get('episode') or 0))
    path = DATASETS / name / 'replay' / f'episode_{ep:03d}.json'
    if not name or not name.replace('-', '').replace('_', '').replace('.', '').isalnum() or '..' in name or not path.exists():
        have = sorted(p.parent.name for p in DATASETS.glob('*/replay'))
        raise RuntimeError(f'재생할 데이터셋 에피소드 없음: {name or "(이름 없음)"} #{ep} '
                           f'(있는 것: {", ".join(have) or "없음"} — 변환 후 check_dataset.py 점검을 통과하면 생김)')
    r = json.loads(path.read_text(encoding='utf-8'))
    missing = [j for j in ctx.joints if j not in r['joints']]
    if missing:
        raise RuntimeError(f'데이터셋에 이 로봇의 관절이 없음: {missing} (데이터셋 관절: {r["joints"]})')
    idx = [r['joints'].index(j) for j in ctx.joints]  # 이름으로 맞춤: 그리퍼 등 추가 관절은 무시
    acts = [[a[i] for i in idx] for a in r['actions']]
    if not acts:
        raise RuntimeError('빈 에피소드')
    speed = max(0.1, float(d.get('speed') or 1))
    now = ctx.joint_now['sim' if ctx.sim else 'real']
    gaps = [abs(a - now[j]) for a, j in zip(acts[0], ctx.joints) if j in now]
    lead = max(1.0, (max(gaps) if len(gaps) == len(ctx.joints) else math.pi) / LEAD_SPEED)  # 지금 자세를 모르면 크게 잡음
    ctx.log(f'녹화 동작 재생: {name} #{ep} "{r.get("task", "")}" ({len(acts)} 프레임, {len(acts) / r["fps"] / speed:.1f}s)')
    follow(ctx, [(acts[0], lead)] + [(a, lead + i / r['fps'] / speed) for i, a in enumerate(acts[1:], 1)])


def move(ctx, degrees, duration):
    positions = [math.radians(float(v)) for v in degrees]
    if len(positions) != len(ctx.joints):
        raise ValueError(f'조인트 값 {len(positions)}개, 필요 {len(ctx.joints)}개')
    follow(ctx, [(positions, duration)])


def follow(ctx, points):
    """[(관절 위치[rad], 시작부터 초)] 궤적을 팔에 보내고 끝날 때까지 기다린다 (정지하면 취소)."""
    # 시뮬레이션 실행이면 실제 팔은 그대로 두고 트윈 팔만 움직인다
    arm, pub = (ctx.sim_arm, ctx.sim_cmd_pub) if ctx.sim else (ctx.arm, ctx.cmd_pub)
    if not arm.wait_for_server(timeout_sec=2):
        raise RuntimeError('시뮬레이션 팔 응답 없음' if ctx.sim else '로봇팔 액션 서버 응답 없음')

    traj = JointTrajectory(joint_names=ctx.joints, points=[JointTrajectoryPoint(
        positions=[float(p) for p in pos], time_from_start=Duration(sec=int(t), nanosec=int(t % 1 * 1e9))) for pos, t in points])
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
