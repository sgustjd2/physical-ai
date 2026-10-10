"""에피소드 녹화 노드. 녹화 자체는 ros/recorder.py 가 하고, 여기서는 /episode/cmd 로 지시하고 응답(ack)을 기다린다.

루프 워크플로라면 [에피소드 시작 → 작업 → 에피소드 종료]를 루프 안에 두면 한 바퀴 = 한 에피소드.
에피소드 종료 없이 워크플로가 끝나거나 정지/오류가 나면 그 상태(done/stopped/error)로 자동 종료된다.
"""
import json
import uuid

from rclpy.qos import DurabilityPolicy, QoSProfile
from std_msgs.msg import String

from nodes import field, node

GROUP = '데이터 수집'
ICON = 'data'
ORDER = 5

LATCHED = QoSProfile(depth=1, durability=DurabilityPolicy.TRANSIENT_LOCAL)


def send(ctx, op, **kw):
    rid = uuid.uuid4().hex[:8]
    ctx.publish('/episode/cmd', String(data=json.dumps({'op': op, 'id': rid, **kw}, ensure_ascii=False)))
    return rid


def request(ctx, op, **kw):
    rid = send(ctx, op, **kw)
    if ctx.count_subscribers('/episode/cmd') == 0:
        raise RuntimeError('녹화기(recorder.py)가 실행 중이 아님')
    m = ctx.wait_for('/episode/status', String, lambda m: json.loads(m.data).get('ack') == rid, 10, LATCHED)
    s = json.loads(m.data)
    if s.get('error'):
        raise RuntimeError(f'녹화: {s["error"]}')
    return s


@node('episode_start', '에피소드 시작 (녹화)', desc='여기부터 관절·카메라를 학습 데이터로 녹화합니다', fields=[
    field('task', '작업 설명 (학습 지시문)', 'text', '물체를 집어서 옮기기'),
])
def episode_start(ctx, d):
    if ctx.sim:  # 시뮬레이션 실행은 학습 데이터로 녹화하지 않는다
        return
    # 시작 응답을 기다리는 중에 정지돼도 녹화가 남지 않도록 정리 훅을 먼저 건다
    ctx.on_finish('episode', lambda state: send(ctx, 'stop', result=state))
    try:
        request(ctx, 'start', task=d.get('task', ''), meta={'source': 'workflow', 'workflow': ctx.graph})
    except RuntimeError:  # 녹화기가 거절함(이미 녹화 중 등) → 우리 녹화가 아니므로 멈추면 안 됨
        ctx.cleanups.pop('episode', None)
        raise


@node('episode_end', '에피소드 종료', desc='녹화를 끝내고 성공/실패를 기록합니다', fields=[
    field('result', '결과', 'select', 'success', options=['success', 'fail']),
])
def episode_end(ctx, d):
    if ctx.sim:
        return
    ctx.cleanups.pop('episode', None)
    request(ctx, 'stop', result=d.get('result', 'success'))
