"""범용 ROS 토픽 노드: 그리퍼, PLC, 센서 등 어떤 장비든 토픽으로 연결한다."""
import json
import operator

from rosidl_runtime_py.set_message import set_message_fields
from rosidl_runtime_py.utilities import get_message

from nodes import field, node

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


@node('wait_topic', '토픽 조건 대기', fields=[
    field('topic', '토픽', 'text', '/sensor/ready'),
    field('field', '필드 (예: data, pose.x)', 'text', 'data'),
    field('op', '조건', 'select', '==', options=list(OPS)),
    field('value', '값', 'text', 'true'),
    field('timeout', '타임아웃 (s, 0=무한)', 'number', 0),
])
def wait_topic(ctx, d):
    topic, op, want = d['topic'], OPS[d.get('op', '==')], parse_value(d.get('value'))
    types = dict(ctx.get_topic_names_and_types())
    if topic not in types:
        raise RuntimeError(f'토픽 없음: {topic}')
    ctx.wait_for(topic, msg_class(types[topic][0]),
                 lambda m: op(get_field(m, d.get('field', '')), want), float(d.get('timeout') or 0))


@node('publish', '토픽 발행', fields=[
    field('topic', '토픽', 'text', '/gripper/cmd'),
    field('type', '메시지 타입', 'text', 'std_msgs/msg/Bool'),
    field('data', '내용 (JSON)', 'json', '{"data": true}'),
])
def publish(ctx, d):
    msg = msg_class(d['type'])()
    set_message_fields(msg, json.loads(d.get('data') or '{}'))
    ctx.publish(d['topic'], msg)
