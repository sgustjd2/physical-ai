"""AI 인식 노드: 카메라 장면을 VLM(Claude)이 보고 판단해 시나리오를 가른다.

카메라 토픽은 로봇 프로파일의 camera_topic (노드 고급 설정에서 바꿀 수 있음).
시뮬레이션 실행에서는 AI를 부르지 않고 '시뮬레이션에서 갈 방향'으로 간다.
"""
import io

from rclpy.qos import qos_profile_sensor_data
from sensor_msgs.msg import CompressedImage, Image

from nodes import field, node

GROUP = 'AI 인식'
ICON = 'vision'
ORDER = 3

SYSTEM = (
    '당신은 산업용 로봇 작업 셀의 비전 검사원입니다. 카메라 이미지 한 장과 예/아니오 질문을 받습니다. '
    '이미지에서 직접 확인할 수 있는 사실만으로 판단하고, 근거를 한국어 한 문장으로 적습니다. '
    '가려져 있거나 흐려서 확인할 수 없으면 confidence를 low로 답합니다.'
)
SCHEMA = {
    'type': 'object',
    'properties': {
        'answer': {'type': 'string', 'enum': ['yes', 'no']},
        'confidence': {'type': 'string', 'enum': ['high', 'medium', 'low']},
        'reason': {'type': 'string'},
    },
    'required': ['answer', 'confidence', 'reason'],
    'additionalProperties': False,
}
CONF = {'high': '확신 높음', 'medium': '확신 보통', 'low': '확신 낮음'}
CHANNELS = {'rgb8': 3, 'bgr8': 3, 'rgba8': 4, 'bgra8': 4, 'mono8': 1}


def grab(ctx, topic, timeout):
    """카메라 토픽에서 최신 프레임 한 장 → (이미지 바이트, media_type)."""
    types = dict(ctx.get_topic_names_and_types())
    if topic not in types:
        raise RuntimeError(f'카메라 토픽 없음: {topic} (로봇 프로파일의 camera_topic 확인)')
    t = types[topic][0]
    if t.endswith('/CompressedImage'):
        m = ctx.wait_for(topic, CompressedImage, lambda _: True, timeout, qos_profile_sensor_data)
        return bytes(m.data), 'image/png' if 'png' in m.format.lower() else 'image/jpeg'
    if t.endswith('/Image'):
        m = ctx.wait_for(topic, Image, lambda _: True, timeout, qos_profile_sensor_data)
        return raw_to_jpeg(m), 'image/jpeg'
    raise RuntimeError(f'이미지 토픽이 아님: {topic} ({t})')


def raw_to_jpeg(m):
    import numpy as np
    from PIL import Image as PILImage

    c = CHANNELS.get(m.encoding)
    if c is None:
        raise RuntimeError(f'지원하지 않는 이미지 인코딩: {m.encoding}')
    a = np.frombuffer(bytes(m.data), np.uint8).reshape(m.height, m.step)[:, :m.width * c].reshape(m.height, m.width, c)
    if m.encoding.startswith('bgr'):
        a = a[..., [2, 1, 0]]
    img = PILImage.fromarray(a[..., 0] if c == 1 else np.ascontiguousarray(a[..., :3]))
    buf = io.BytesIO()
    img.convert('RGB').save(buf, 'JPEG', quality=90)
    return buf.getvalue()


@node('vlm_check', 'AI 비전 판단', desc='카메라 영상을 보고 AI가 질문에 예/아니오로 답합니다', fields=[
    field('question', '질문 (예/아니오로 답할 수 있게)', 'text', '작업대 위에 부품이 있나요?'),
    field('camera', '카메라 토픽 (비우면 프로파일 값)', 'text', '', advanced=True),
    field('timeout', '이미지 대기 (s)', 'number', 3, advanced=True),
    field('on_low', '확신이 낮을 때', 'select', '정지', options=['정지', '아니오로 처리'], advanced=True),
    field('sim_result', '시뮬레이션에서 갈 방향', 'select', '예', options=['예', '아니오'], advanced=True),
], outputs=[('yes', '예'), ('no', '아니오')])
def vlm_check(ctx, d):
    """카메라 장면을 보고 예/아니오 질문에 답한다. 판단과 근거는 실행 기록에 남는다."""
    q = d.get('question') or ''
    if ctx.sim:
        ctx.log(f'시뮬레이션: AI 판단 생략, "{d.get("sim_result", "예")}"(으)로 진행 ({q})')
        return 'yes' if d.get('sim_result', '예') == '예' else 'no'
    try:
        import ai_client  # 실제 실행에서만 필요 (anthropic 패키지가 없어도 다른 노드는 동작하도록)
    except ImportError as e:
        raise RuntimeError('AI 패키지(anthropic)가 설치되지 않음: ros 이미지를 다시 빌드하세요') from e
    topic = d.get('camera') or ctx.param('camera_topic', '/camera/color/image_raw/compressed')
    data, media = grab(ctx, topic, float(d.get('timeout') or 3))
    r = ai_client.ask_json([ai_client.image_block(data, media), {'type': 'text', 'text': q}], SCHEMA, SYSTEM)
    ans = '예' if r['answer'] == 'yes' else '아니오'
    ctx.log(f'AI 판단: {ans} ({CONF[r["confidence"]]}) — {r["reason"]} [질문: {q}]')
    if r['confidence'] == 'low' and d.get('on_low', '정지') == '정지':
        raise RuntimeError(f'AI가 확신하지 못함: {r["reason"]}')
    return r['answer']
