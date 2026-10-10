"""워크플로 노드 타입 플러그인.

새 노드 타입 = 이 폴더에 파이썬 파일 하나. 웹 UI(팔레트, 입력 폼, 출력 포트)는 여기서 선언한 내용으로
자동 생성되므로 웹 코드는 고치지 않는다.

    from nodes import node, field

    GROUP = '장비 연동'   # 팔레트 분류 (같은 분류 = 같은 색)
    ICON = 'device'       # 분류 아이콘: arm | flow | device | data | vision (없으면 점)
    ORDER = 3             # 팔레트에서 분류가 놓이는 순서 (작을수록 위)

    @node('beep', '비프', desc='부저를 N번 울립니다', fields=[field('count', '횟수', 'number', 1)])
    def beep(ctx, d):
        if ctx.sim:                      # 시뮬레이션 실행: 실제 장비는 건드리지 않는다
            return
        for _ in range(int(d['count'])):
            ctx.sleep(0.2)

    # 분기: 출력 포트를 선언하고, 따라갈 포트 id를 돌려준다
    @node('check', '검사', outputs=[('ok', '합격'), ('ng', '불량')])
    def check(ctx, d):
        return 'ok'

    def setup(ctx):  # 선택: 실행기 시작 시 한 번 (퍼블리셔/액션 클라이언트 생성 등)
        ...

실행 규칙:
  - 노드 함수가 돌려준 포트(없으면 첫 번째 포트)에 연결된 노드로 진행한다.
  - 한 포트에 연결이 여럿이면 병렬로 실행된다. '합류' 노드는 들어오는 갈래가 모두 도착하면 한 번 진행한다.
  - 노드 함수는 실행 스레드(병렬이면 여러 스레드)에서 돌고, 예외를 던지면 워크플로가 error로 멈춘다.
  - 오래 기다릴 때는 반드시 ctx 헬퍼를 써야 정지 버튼이 먹는다.
  - ctx.sim 이 참이면 '시뮬레이션 실행'이다: 팔은 트윈(/sim)만 움직이고, 실제 장비 출력·센서 대기·녹화는 건너뛴다.

ctx (workflow_executor.WorkflowExecutor, rclpy Node) 가 제공하는 것:
  ctx.joints                          로봇 프로파일의 관절 이름
  ctx.sim                             시뮬레이션 실행 여부
  ctx.current                         지금 실행 중인 노드 id (이 스레드 기준)
  ctx.run_state                       이번 실행 동안 유지되는 dict (반복 횟수 등)
  ctx.param(name, default)            ROS 파라미터 (로봇 프로파일 값이 런치에서 들어옴)
  ctx.sleep(sec)                      정지 가능한 대기
  ctx.wait_until(pred, timeout=0)     pred()가 참이 될 때까지 (0 = 무한)
  ctx.wait_for(topic, cls, pred, timeout=0, qos=10)  조건을 만족하는 메시지가 올 때까지, 그 메시지 반환
  ctx.publish(topic, msg)             퍼블리셔 캐시 + 첫 메시지 유실 방지
  ctx.on_finish(key, fn)              워크플로가 어떻게 끝나든 fn(state) 호출 (정리용). ctx.cleanups.pop(key)로 해제
  ctx.log(text)                       실행 기록(/workflow/log)에 한 줄 남김 — 웹 '기록' 탭에 보인다 (AI 판단 근거 등)
  ctx.graph                           실행 중인 그래프 (메타데이터 기록용)

field kind: text | number | select(options) | json | joints(관절 수만큼 입력 + 현재 자세 티칭)
            | camera(이미지 토픽 선택 + 실시간 미리보기, 값이 비면 로봇 프로파일의 camera_topic)
field/node 의 advanced=True: 비개발자 화면에서는 접어 두는 고급 항목/노드
"""
import importlib
import pkgutil
import sys

REGISTRY = {}  # type -> {'run': fn, 'spec': {...}}
MODULES = []
DEFAULT_OUTPUTS = [('out', '')]


def field(key, label, kind='text', default='', options=None, advanced=False):
    """advanced=True 면 웹 인스펙터의 '고급 설정' 아래로 접힌다 (비개발자에게는 핵심 항목만)."""
    f = {'key': key, 'label': label, 'kind': kind, 'default': default}
    if options:
        f['options'] = options
    if advanced:
        f['advanced'] = True
    return f


def node(type_, label, fields=(), outputs=DEFAULT_OUTPUTS, advanced=False, desc=''):
    """desc: 블록 선택 창에 보이는 한 줄 설명 (비개발자가 무엇을 하는 블록인지 알 수 있게).
    advanced=True 면 블록 선택 창의 '고급' 영역에 접혀 들어간다 (ROS 토픽을 직접 다루는 노드 등)."""
    def deco(fn):
        if type_ in REGISTRY:
            raise ValueError(f'노드 타입 중복: {type_}')
        mod = sys.modules.get(fn.__module__)
        REGISTRY[type_] = {'run': fn, 'spec': {
            'type': type_, 'label': label, 'fields': list(fields),
            'group': getattr(mod, 'GROUP', '기타'), 'icon': getattr(mod, 'ICON', ''), 'order': getattr(mod, 'ORDER', 100),
            'outputs': [{'id': i, 'label': lb} for i, lb in outputs], 'advanced': advanced, 'desc': desc,
        }}
        return fn
    return deco


def first_port(type_):
    spec = REGISTRY.get(type_, {}).get('spec')
    return spec['outputs'][0]['id'] if spec else 'out'


def load_all():
    """이 폴더의 모든 모듈을 import 해서 @node 들을 등록한다."""
    for m in pkgutil.iter_modules(__path__):
        MODULES.append(importlib.import_module(f'{__name__}.{m.name}'))
    return MODULES
