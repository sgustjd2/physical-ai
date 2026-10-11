"""흐름 제어 노드: 대기, 조건 분기, 반복, 합류."""
from nodes import field, node
from nodes.topics import OPS, get_field, msg_class, parse_value

GROUP = '흐름'
ICON = 'flow'
ORDER = 2


@node('wait', '대기', desc='정해진 시간만큼 기다립니다', fields=[field('sec', '시간 (s)', 'number', 1)])
def wait(ctx, d):
    ctx.sleep(float(d['sec']))


@node('if', '조건 분기', desc='센서 신호 값을 보고 예/아니오로 갈라집니다', fields=[
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


@node('loop', '반복', desc='연결한 단계들을 N번 되풀이한 뒤 완료로 넘어갑니다', fields=[field('count', '반복 횟수', 'number', 3)],
      outputs=[('repeat', '반복'), ('done', '완료')])
def loop(ctx, d):
    """'반복' 쪽으로 N번 보낸 뒤 '완료' 쪽으로 보낸다. 반복할 단계들의 끝을 이 노드로 다시 연결한다."""
    key = ('loop', ctx.current)
    n = ctx.run_state.get(key, 0)
    total = int(float(d.get('count') or 0))
    # 운영 화면: 진행(완료한 반복/전체)과 처리한 반복 수. ponytail: 반복 안의 반복이면 안쪽 진행이 보이고 수는 둘 다 더해짐
    if n:  # 직전 반복을 끝내고 돌아옴
        ctx.run_state['cycles'] = ctx.run_state.get('cycles', 0) + 1
    ctx.run_state['progress'] = [n, total]
    if n < total:
        ctx.run_state[key] = n + 1
        return 'repeat'
    ctx.run_state[key] = 0
    return 'done'


@node('join', '합류', desc='동시에 실행한 갈래가 모두 끝나면 다음으로 진행합니다')
def join(ctx, d):
    """병렬 갈래가 모두 도착하면 한 번 진행한다. 도착 수는 실행기가 세므로 이 함수는 호출되지 않는다."""
