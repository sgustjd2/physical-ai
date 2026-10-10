"""Claude 호출 한곳: AI 비전 판단(nodes/vision.py)과 시나리오 생성(scenario_ai.py)이 함께 쓴다.

공식 anthropic SDK 사용. 인증은 환경변수 ANTHROPIC_API_KEY (docker-compose가 .env에서 넘김).
키를 repo에 넣지 않는다. 응답은 JSON 스키마로 받는 구조화된 출력이라 파싱이 깨지지 않는다.
거절(refusal)되면 서버가 다른 모델로 다시 돌리도록 fallbacks="default"를 켠다.
"""
import base64
import json

import anthropic

MODEL = 'claude-opus-5-5'
_client = None


def client():
    global _client
    if _client is None:
        _client = anthropic.Anthropic()  # ANTHROPIC_API_KEY 등 환경의 인증 정보를 쓴다
    return _client


def image_block(data, media_type='image/jpeg'):
    return {'type': 'image', 'source': {'type': 'base64', 'media_type': media_type,
                                        'data': base64.standard_b64encode(data).decode('ascii')}}


def ask_json(content, schema, system, effort='low', max_tokens=4000):
    """content(텍스트·이미지 블록 목록)를 보내고 schema에 맞는 JSON(dict)을 돌려받는다.
    실패는 현장 화면에 그대로 보여 줄 수 있는 한국어 RuntimeError로 바꾼다."""
    try:
        resp = client().beta.messages.create(
            model=MODEL,
            max_tokens=max_tokens,
            system=system,
            messages=[{'role': 'user', 'content': content}],
            output_config={'effort': effort, 'format': {'type': 'json_schema', 'schema': schema}},
            betas=['server-side-fallback-2026-07-01'],
            fallbacks='default',
        )
    except anthropic.AuthenticationError as e:
        raise RuntimeError('AI 인증 실패: GB10의 .env에 ANTHROPIC_API_KEY를 확인하세요') from e
    except anthropic.PermissionDeniedError as e:
        raise RuntimeError('AI 권한 없음: API 키의 권한을 확인하세요') from e
    except anthropic.RateLimitError as e:
        raise RuntimeError('AI 요청 한도 초과: 잠시 후 다시 실행하세요') from e
    except anthropic.APIStatusError as e:
        raise RuntimeError(f'AI 서버 오류 ({e.status_code}): {e.message}') from e
    except anthropic.APIConnectionError as e:
        raise RuntimeError('AI 서버에 연결할 수 없음: GB10의 인터넷 연결을 확인하세요') from e
    except anthropic.AnthropicError as e:  # 인증 정보가 아예 없을 때 등 SDK 쪽 오류
        raise RuntimeError(f'AI 호출 준비 실패: GB10의 .env에 ANTHROPIC_API_KEY가 있는지 확인하세요 ({e})') from e
    if resp.stop_reason == 'refusal':
        cat = resp.stop_details.category if resp.stop_details else None
        raise RuntimeError(f'AI가 요청을 거절함{f" ({cat})" if cat else ""}')
    if resp.stop_reason == 'max_tokens':
        raise RuntimeError('AI 응답이 길어 잘림: 요청을 더 짧게 나눠 주세요')
    text = next((b.text for b in resp.content if b.type == 'text'), None)
    if text is None:
        raise RuntimeError('AI 응답에 결과가 없음')
    return json.loads(text)
