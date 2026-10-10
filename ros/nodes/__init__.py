"""워크플로 노드 타입 플러그인.

새 노드 타입 = 이 폴더에 파이썬 파일 하나. 웹 UI(팔레트, 입력 폼)는 여기서 선언한 fields로 자동 생성되므로
웹 코드는 고치지 않는다.

    from nodes import node, field

    @node('beep', '비프', fields=[field('count', '횟수', 'number', 1)])
    def beep(ctx, d):
        for _ in range(int(d['count'])):
            ctx.get_logger().info('beep')
            ctx.sleep(0.2)

    def setup(ctx):  # 선택: 실행기 시작 시 한 번 (퍼블리셔/액션 클라이언트 생성 등)
        ...

노드 함수는 실행 스레드에서 돌고, 예외를 던지면 워크플로가 error로 멈춘다.
오래 기다릴 때는 반드시 ctx 헬퍼를 써야 정지 버튼이 먹는다.

ctx (workflow_executor.WorkflowExecutor, rclpy Node) 가 제공하는 것:
  ctx.joints                          로봇 프로파일의 관절 이름
  ctx.param(name, default)            ROS 파라미터 (로봇 프로파일 값이 런치에서 들어옴)
  ctx.sleep(sec)                      정지 가능한 대기
  ctx.wait_until(pred, timeout=0)     pred()가 참이 될 때까지 (0 = 무한)
  ctx.wait_for(topic, cls, pred, timeout=0, qos=10)  조건을 만족하는 메시지가 올 때까지, 그 메시지 반환
  ctx.publish(topic, msg)             퍼블리셔 캐시 + 첫 메시지 유실 방지
  ctx.on_finish(key, fn)              워크플로가 어떻게 끝나든 fn(state) 호출 (정리용). ctx.cleanups.pop(key)로 해제
  ctx.graph                           실행 중인 그래프 (메타데이터 기록용)

field kind: text | number | select(options) | json | joints(관절 수만큼 입력 + 현재 자세 티칭)
"""
import importlib
import pkgutil

REGISTRY = {}  # type -> {'run': fn, 'spec': {...}}
MODULES = []


def field(key, label, kind='text', default='', options=None):
    f = {'key': key, 'label': label, 'kind': kind, 'default': default}
    if options:
        f['options'] = options
    return f


def node(type_, label, fields=()):
    def deco(fn):
        if type_ in REGISTRY:
            raise ValueError(f'노드 타입 중복: {type_}')
        REGISTRY[type_] = {'run': fn, 'spec': {'type': type_, 'label': label, 'fields': list(fields)}}
        return fn
    return deco


def load_all():
    """이 폴더의 모든 모듈을 import 해서 @node 들을 등록한다."""
    for m in pkgutil.iter_modules(__path__):
        MODULES.append(importlib.import_module(f'{__name__}.{m.name}'))
    return MODULES
