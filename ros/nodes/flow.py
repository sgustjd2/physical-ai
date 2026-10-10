"""흐름 제어 노드: 대기, 조건 분기, 반복, 합류."""
from nodes import field, node
from nodes.topics import OPS, get_field, msg_class, parse_value

GROUP = '흐름'
ICON = 'flow'
ORDER = 2


@node('wait', '대기', fields=[field('sec', '시간 (s)', 'number', 1)])
def wait(ctx, d):
    ctx.sleep(float(d['sec']))


@node('if', '조건 분기', fields=[
    field('topic', '확인할 신호 (토픽)', 'text', '/sensor/part_present'),
    field('op', '조건', 'select', '==', options=list(OPS)),
    field('value', '값', 'text', 'true'),
    field('field', '필드 (예: data, pose.x)', 'text', 'data', advanced=True),
    field('timeout', '신호 대기 시간 (s)', 'number', 5, advanced=True),
    field('sim_result', '시뮬레이션에서 갈 방향', 'select', '예', options=['예', '아니오'], advanced=True),
], outputs=[('yes', '예'), ('no', '아니오')])
def if_(ctx, d):
    """신호(토픽)의 최신 값을 한 번 보고 예/아니오로 갈라진다. 시뮬레이션에서는 지정한 방향으로 간다."""
    if ctx.sim:
        return 'yes' if d.get('sim_result', '예') == '예' else 'no'
    topic = d['topic']
    types = dict(ctx.get_topic_names_and_types())
    if topic not in types:
        raise RuntimeError(f'토픽 없음: {topic}')
    m = ctx.wait_for(topic, msg_class(types[topic][0]), lambda _: True, float(d.get('timeout') or 5))
    return 'yes' if OPS[d.get('op', '==')](get_field(m, d.get('field', '')), parse_value(d.get('value'))) else 'no'


@node('loop', '반복', fields=[field('count', '반복 횟수', 'number', 3)],
      outputs=[('repeat', '반복'), ('done', '완료')])
def loop(ctx, d):
    """'반복' 쪽으로 N번 보낸 뒤 '완료' 쪽으로 보낸다. 반복할 단계들의 끝을 이 노드로 다시 연결한다."""
    key = ('loop', ctx.current)
    n = ctx.run_state.get(key, 0)
    if n < int(float(d.get('count') or 0)):
        ctx.run_state[key] = n + 1
        return 'repeat'
    ctx.run_state[key] = 0
    return 'done'


@node('join', '합류')
def join(ctx, d):
    """병렬 갈래가 모두 도착하면 한 번 진행한다. 도착 수는 실행기가 세므로 이 함수는 호출되지 않는다."""
