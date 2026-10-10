"""장비 연동 노드: 그리퍼, PLC, 센서 등. 토픽을 직접 다루는 범용 노드는 '고급'으로 접어 둔다.
시뮬레이션 실행에서는 실제 장비에 아무것도 보내지 않는다.
"""
import json
import operator

from rosidl_runtime_py.set_message import set_message_fields
from std_msgs.msg import Bool
from rosidl_runtime_py.utilities import get_message

from nodes import field, node

GROUP = '장비 연동'
ICON = 'device'
ORDER = 3

OPS = {'==': operator.eq, '!=': operator.ne, '>': operator.gt,
       '<': operator.lt, '>=': operator.ge, '<=': operator.le}


def parse_value(s):
    """UI 입력 문자열 → 값. 'true'→True, '3.5'→3.5, 그 외는 문자열 그대로."""
    try:
        return json.loads(s)
    except (ValueError, TypeError):
        return s


def get_field(msg, path):
    for part in filter(None, path.split('.')):
        msg = getattr(msg, part)
    return msg


def msg_class(type_name):
    parts = type_name.split('/')
    return get_message('/'.join([parts[0], 'msg', parts[1]]) if len(parts) == 2 else type_name)


@node('gripper', '그리퍼', fields=[
    field('action', '동작', 'select', '닫기', options=['닫기', '열기']),
    field('settle', '동작 후 대기 (s)', 'number', 0.5, advanced=True),
])
def gripper(ctx, d):
    """그리퍼 열기/닫기. 토픽은 로봇 프로파일의 gripper_topic (std_msgs/Bool, true=닫기)."""
    if not ctx.sim:
        ctx.publish(ctx.param('gripper_topic', '/gripper/cmd'), Bool(data=d.get('action', '닫기') == '닫기'))
    ctx.sleep(float(d.get('settle') or 0))


@node('wait_topic', '신호 대기', advanced=True, fields=[
    field('topic', '토픽', 'text', '/sensor/ready'),
    field('op', '조건', 'select', '==', options=list(OPS)),
    field('value', '값', 'text', 'true'),
    field('field', '필드 (예: data, pose.x)', 'text', 'data', advanced=True),
    field('timeout', '타임아웃 (s, 0=무한)', 'number', 0, advanced=True),
])
def wait_topic(ctx, d):
    if ctx.sim:  # 시뮬레이션: 실제 센서를 기다리지 않고 통과
        ctx.sleep(0.3)
        return
    topic, op, want = d['topic'], OPS[d.get('op', '==')], parse_value(d.get('value'))
    types = dict(ctx.get_topic_names_and_types())
    if topic not in types:
        raise RuntimeError(f'토픽 없음: {topic}')
    ctx.wait_for(topic, msg_class(types[topic][0]),
                 lambda m: op(get_field(m, d.get('field', '')), want), float(d.get('timeout') or 0))


@node('publish', '토픽 발행', advanced=True, fields=[
    field('topic', '토픽', 'text', '/gripper/cmd'),
    field('type', '메시지 타입', 'text', 'std_msgs/msg/Bool'),
    field('data', '내용 (JSON)', 'json', '{"data": true}'),
])
def publish(ctx, d):
    if ctx.sim:  # 시뮬레이션: 실제 장비에 보내지 않는다
        return
    msg = msg_class(d['type'])()
    set_message_fields(msg, json.loads(d.get('data') or '{}'))
    ctx.publish(d['topic'], msg)
