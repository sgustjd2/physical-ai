"""AI 기능 단위 테스트 (ROS·API 키 불필요): 시나리오 검증과 Claude 요청 구성.

  python3 test_ai.py
"""
import json
from types import SimpleNamespace

import ai_client
import scenario

SPECS = [
    {'type': 'move_j', 'label': 'MoveJ', 'group': '동작', 'outputs': [{'id': 'out', 'label': ''}],
     'fields': [{'key': 'joints', 'label': '관절 각도 (°)', 'kind': 'joints', 'default': ''},
                {'key': 'duration', 'label': '이동 시간 (s)', 'kind': 'number', 'default': 2}]},
    {'type': 'vlm_check', 'label': 'AI 비전 판단', 'group': 'AI 인식', 'outputs': [{'id': 'yes', 'label': '예'}, {'id': 'no', 'label': '아니오'}],
     'fields': [{'key': 'question', 'label': '질문', 'kind': 'text', 'default': ''},
                {'key': 'on_low', 'label': '확신이 낮을 때', 'kind': 'select', 'default': '정지', 'options': ['정지', '아니오로 처리']}]},
    {'type': 'loop', 'label': '반복', 'group': '흐름', 'outputs': [{'id': 'repeat', 'label': '반복'}, {'id': 'done', 'label': '완료'}],
     'fields': [{'key': 'count', 'label': '반복 횟수', 'kind': 'number', 'default': 3}]},
]


def raw(nodes, edges):
    return {'summary': 's', 'nodes': nodes, 'edges': edges}


def n(id_, type_, **fields):
    return {'id': id_, 'type': type_, 'fields': [{'key': k, 'value': str(v)} for k, v in fields.items()]}


# --- validate: 정상 그래프 (반복 + AI 판단 분기) ---
g, w = scenario.validate(raw(
    [n('start', 'start'), n('loop', 'loop', count=2), n('see', 'vlm_check', question='부품이 있나요?'),
     n('pick', 'move_j', joints='10, 20, 30', duration=1), n('home', 'move_j')],
    [{'source': 'start', 'target': 'loop', 'port': ''}, {'source': 'loop', 'target': 'see', 'port': 'repeat'},
     {'source': 'see', 'target': 'pick', 'port': 'yes'}, {'source': 'see', 'target': 'loop', 'port': 'no'},
     {'source': 'pick', 'target': 'loop', 'port': ''}, {'source': 'loop', 'target': 'home', 'port': 'done'}]), SPECS, 6)
by_id = {x['id']: x for x in g['nodes']}
assert by_id['pick']['data']['joints'] == [10, 20, 30, 0, 0, 0], by_id['pick']
assert by_id['home']['data']['joints'] == [0] * 6 and by_id['home']['data']['duration'] == 2
assert by_id['see']['data']['on_low'] == '정지'  # 빠진 필드는 기본값
assert {e['id'] for e in g['edges']} >= {'loop-repeat-see', 'see-yes-pick', 'see-no-loop', 'loop-done-home'}
assert next(e for e in g['edges'] if e['id'] == 'start-out-loop').get('sourceHandle') is None
assert any('6개로 맞춤' in x for x in w), w

# --- validate: 고치는 문제는 경고, 구조 문제는 거절 ---
_, w = scenario.validate(raw([n('start', 'start'), n('see', 'vlm_check', on_low='모름', extra=1)],
                             [{'source': 'start', 'target': 'see', 'port': ''}]), SPECS, 6)
assert any('선택지에 없어' in x for x in w) and any('알 수 없는 항목 "extra"' in x for x in w), w
for bad, why in [
    (raw([n('start', 'start'), n('x', 'teleport')], []), '없는 노드 타입'),
    (raw([n('start', 'start'), n('see', 'vlm_check')], [{'source': 'see', 'target': 'start', 'port': 'maybe'}]), '없는 출력'),
    (raw([n('a', 'move_j')], []), '시작 노드'),
    (raw([n('start', 'start')], [{'source': 'start', 'target': 'ghost', 'port': ''}]), '없는 노드를 잇는'),
]:
    try:
        scenario.validate(bad, SPECS, 6)
        raise AssertionError(f'통과하면 안 됨: {why}')
    except ValueError as e:
        assert why in str(e), (why, e)

# --- 프롬프트용 노드 설명에 포트와 선택지가 들어가는지 ---
text = scenario.describe(SPECS, ['j1', 'j2'])
assert 'vlm_check' in text and 'yes(예)' in text and '선택지=정지/아니오로 처리' in text and '관절 2개' in text


# --- ai_client: 실제 SDK 객체 대신 가짜 응답으로 요청 구성과 응답 처리를 확인 ---
class FakeMessages:
    def __init__(self, resp):
        self.resp, self.kw = resp, None

    def create(self, **kw):
        self.kw = kw
        return self.resp


def fake(stop_reason, text=None, stop_details=None):
    content = [SimpleNamespace(type='text', text=text)] if text is not None else []
    msgs = FakeMessages(SimpleNamespace(stop_reason=stop_reason, content=content, stop_details=stop_details))
    ai_client._client = SimpleNamespace(beta=SimpleNamespace(messages=msgs))
    return msgs


msgs = fake('end_turn', json.dumps({'answer': 'yes', 'confidence': 'high', 'reason': '부품이 보임'}))
out = ai_client.ask_json([ai_client.image_block(b'\xff\xd8jpeg'), {'type': 'text', 'text': '부품?'}], {'type': 'object'}, 'sys')
assert out['answer'] == 'yes'
kw = msgs.kw
assert kw['model'] == 'claude-opus-5-5' and kw['fallbacks'] == 'default' and kw['betas'] == ['server-side-fallback-2026-07-01']
assert kw['output_config']['format']['type'] == 'json_schema' and kw['output_config']['effort'] == 'low'
img = kw['messages'][0]['content'][0]
assert img['type'] == 'image' and img['source']['media_type'] == 'image/jpeg' and img['source']['data'] == '/9hqcGVn'

fake('refusal', stop_details=SimpleNamespace(category='cyber'))
try:
    ai_client.ask_json([], {}, 'sys')
    raise AssertionError('거절은 예외여야 함')
except RuntimeError as e:
    assert '거절' in str(e) and 'cyber' in str(e)

print('test_ai OK')
