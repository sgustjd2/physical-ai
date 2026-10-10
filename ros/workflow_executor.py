"""워크플로 실행기: 웹 노드 에디터에서 만든 그래프를 받아 실행한다.

토픽 (std_msgs/String 안에 JSON):
  /workflow/run        ← {"nodes": [{id, type, data}], "edges": [{source, target, sourceHandle?}], "mode": "real"|"sim"}
  /workflow/stop       ← std_msgs/Empty
  /workflow/status     → {"state": idle|running|done|error|stopped, "node": id, "active": [id], "mode", "msg", "joints"}
  /workflow/node_types → [{type, label, group, icon, fields, outputs}]  (웹이 팔레트·입력 폼·출력 포트를 만드는 데 씀)

이 파일은 그래프를 걷는 일만 한다. 노드 타입별 동작은 nodes/ 플러그인에 있다.
  - start에서 출발해, 노드가 돌려준 출력 포트(sourceHandle)에 연결된 노드로 진행한다.
  - 한 포트에 연결이 여럿이면 갈래마다 스레드를 나눠 병렬로 실행한다.
  - '합류'(join) 노드는 들어오는 엣지 수만큼 도착하면 한 번 진행한다.
  - 엣지가 앞 노드로 돌아가면 반복(반복 노드의 횟수 또는 정지 버튼까지).
  - mode == "sim" 이면 시뮬레이션 실행 (ctx.sim). 각 플러그인이 실제 장비를 건드리지 않는다.
"""
import json
import math
import threading
import time
from collections import defaultdict

import rclpy
from rclpy.executors import ExternalShutdownException
from rclpy.node import Node
from rclpy.qos import DurabilityPolicy, QoSProfile
from std_msgs.msg import Empty, String

import nodes

LATCHED = QoSProfile(depth=1, durability=DurabilityPolicy.TRANSIENT_LOCAL)


class Graph:
    """실행용 색인: (노드, 포트) → 다음 노드들, 합류 노드의 진입 수."""

    def __init__(self, graph):
        self.nodes = {n['id']: n for n in graph['nodes']}
        self.start = next((n['id'] for n in graph['nodes'] if n['type'] == 'start'), None)
        if self.start is None:
            raise ValueError('시작 노드가 없음')
        self.out = defaultdict(list)
        self.indegree = defaultdict(int)
        for e in graph['edges']:
            src = self.nodes.get(e['source'])
            if src is None or e['target'] not in self.nodes:
                continue  # 지워진 노드를 가리키는 엣지는 무시
            port = e.get('sourceHandle') or nodes.first_port(src['type'])
            self.out[(e['source'], port)].append(e['target'])
            self.indegree[e['target']] += 1

    def next(self, node_id, port):
        return self.out[(node_id, port)]


def next_node(graph, node_id):
    """(호환·테스트용) 기본 포트의 첫 다음 노드."""
    g = Graph(graph) if any(n['type'] == 'start' for n in graph.get('nodes', [])) else None
    if g:
        t = g.next(node_id, nodes.first_port(g.nodes[node_id]['type']))
        return t[0] if t else None
    return next((e['target'] for e in graph['edges'] if e['source'] == node_id), None)


class Stopped(Exception):
    pass


class WorkflowExecutor(Node):
    def __init__(self):
        super().__init__('workflow_executor')
        self.joints = self.param('joints', [f'joint{i}' for i in range(1, 7)])
        self.stop = threading.Event()
        self.lock = threading.Lock()          # 실행 상태(활성 노드, 합류 카운터, 오류)
        self.entity_lock = threading.Lock()   # 병렬 갈래가 퍼블리셔/구독을 동시에 만들 때
        self.tls = threading.local()
        self.thread = None
        self.graph = None
        self.sim = False
        self.run_state = {}
        self.cleanups = {}
        self.pubs = {}
        self.active = []
        self.last_node = None
        self.walkers = []
        self.errors = []
        self.status_pub = self.create_publisher(String, '/workflow/status', LATCHED)
        self.create_subscription(String, '/workflow/run', self.on_run, 10)
        self.create_subscription(Empty, '/workflow/stop', lambda _: self.stop.set(), 10)

        for m in nodes.load_all():
            if hasattr(m, 'setup'):
                m.setup(self)
        specs = sorted((n['spec'] for n in nodes.REGISTRY.values()), key=lambda s: s['order'])
        self.create_publisher(String, '/workflow/node_types', LATCHED).publish(
            String(data=json.dumps(specs, ensure_ascii=False)))
        self.get_logger().info(f'노드 타입: {", ".join(nodes.REGISTRY)}')
        self.status('idle')

    # ---- 플러그인용 헬퍼 (nodes/__init__.py 참고) ----
    @property
    def current(self):
        return getattr(self.tls, 'node', None)

    def param(self, name, default):
        if not self.has_parameter(name):
            self.declare_parameter(name, default)
        return self.get_parameter(name).value

    def sleep(self, sec):
        if self.stop.wait(sec):
            raise Stopped

    def wait_until(self, done, timeout=0):
        """done()이 참이 될 때까지 대기. 정지 요청이면 Stopped, 시간 초과면 TimeoutError."""
        t_end = time.monotonic() + timeout if timeout else math.inf
        while not done():
            if self.stop.wait(0.02):
                raise Stopped
            if time.monotonic() > t_end:
                raise TimeoutError(f'{timeout}초 시간 초과')

    def wait_for(self, topic, msg_cls, pred, timeout=0, qos=10):
        hit, err = [], []

        def cb(m):
            if hit:
                return
            try:
                if pred(m):
                    hit.append(m)
            except Exception as e:  # noqa: BLE001 — 콜백 예외는 spin을 죽이므로 실행 스레드로 넘긴다
                err.append(e)

        with self.entity_lock:
            sub = self.create_subscription(msg_cls, topic, cb, qos)
        try:
            self.wait_until(lambda: hit or err, timeout)
        finally:
            with self.entity_lock:
                self.destroy_subscription(sub)
        if err:
            raise err[0]
        return hit[0]

    def publish(self, topic, msg):
        key = (topic, type(msg))
        with self.entity_lock:
            pub = self.pubs.get(key)
            fresh = pub is None
            if fresh:
                self.pubs[key] = pub = self.create_publisher(type(msg), topic, 10)
        if fresh:
            # ponytail: 새 퍼블리셔는 디스커버리 전에 보낸 메시지를 잃으므로 구독자를 최대 1초 기다림
            t_end = time.monotonic() + 1
            while pub.get_subscription_count() == 0 and time.monotonic() < t_end:
                time.sleep(0.05)
        pub.publish(msg)

    def on_finish(self, key, fn):
        self.cleanups[key] = fn

    # ---- 실행 ----
    def status(self, state, node=None, msg=''):
        data = {'state': state, 'node': node, 'active': list(self.active), 'msg': msg,
                'mode': 'sim' if self.sim else 'real', 'joints': self.joints}
        self.status_pub.publish(String(data=json.dumps(data, ensure_ascii=False)))

    def on_run(self, msg):
        if self.thread and self.thread.is_alive():
            self.get_logger().warn('이미 실행 중, 무시함')
            return
        try:
            graph = json.loads(msg.data)
        except ValueError as e:
            self.status('error', msg=f'잘못된 JSON: {e}')
            return
        self.stop.clear()
        self.thread = threading.Thread(target=self.run, args=(graph,), daemon=True)
        self.thread.start()

    def fork(self, g, targets):
        for t in targets:
            th = threading.Thread(target=self.walk, args=(g, t), daemon=True)
            with self.lock:
                self.walkers.append(th)
            th.start()

    def walk(self, g, node_id):
        """한 갈래를 끝(또는 합류 대기)까지 따라간다."""
        try:
            while node_id is not None:
                n = g.nodes[node_id]
                if n['type'] == 'join':
                    with self.lock:
                        key = ('join', node_id)
                        self.run_state[key] = self.run_state.get(key, 0) + 1
                        if self.run_state[key] < g.indegree[node_id]:
                            return  # 마지막으로 도착한 갈래가 이어서 진행
                        self.run_state[key] = 0  # 반복으로 다시 올 때를 위해 초기화
                    port = nodes.first_port('join')
                else:
                    if n['type'] not in nodes.REGISTRY:
                        raise ValueError(f'이 서버에 없는 노드 타입: {n["type"]}')
                    with self.lock:
                        self.active.append(node_id)
                        self.last_node = node_id
                        self.status('running', node_id)
                    self.tls.node = node_id
                    try:
                        port = nodes.REGISTRY[n['type']]['run'](self, n.get('data') or {}) or nodes.first_port(n['type'])
                    finally:
                        with self.lock:
                            self.active.remove(node_id)
                targets = g.next(node_id, port)
                self.fork(g, targets[1:])
                node_id = targets[0] if targets else None
        except Stopped:
            pass
        except Exception as e:  # noqa: BLE001 — 한 갈래의 실패는 전체 실행을 멈춘다
            self.get_logger().error(f'{node_id}: {e!r}')
            with self.lock:
                self.errors.append((node_id, e))
            self.stop.set()

    def run(self, graph):
        self.graph, self.cleanups, self.run_state = graph, {}, {}
        self.sim = graph.get('mode') == 'sim'
        self.active, self.walkers, self.errors, self.last_node = [], [], [], None
        state, node_id, err = 'done', None, ''
        try:
            g = Graph(graph)
            self.fork(g, g.next(g.start, nodes.first_port('start')))
            while True:  # 모든 갈래(실행 중 새로 갈라진 것 포함)가 끝날 때까지
                with self.lock:
                    alive = [t for t in self.walkers if t.is_alive()]
                if not alive:
                    break
                alive[0].join(0.05)
            if self.errors:
                node_id, e = self.errors[0]
                state, err = 'error', f'{type(e).__name__}: {e}'
            elif self.stop.is_set():
                state, node_id = 'stopped', self.last_node
        except Exception as e:  # noqa: BLE001 — 그래프 자체 오류 (시작 노드 없음 등)
            self.get_logger().error(repr(e))
            state, err = 'error', f'{type(e).__name__}: {e}'
        for fn in self.cleanups.values():
            try:
                fn(state)
            except Exception as e:  # noqa: BLE001
                self.get_logger().error(f'정리 실패: {e!r}')
        self.active = []
        self.status(state, node_id, err)


def main():
    rclpy.init()
    try:
        rclpy.spin(WorkflowExecutor())
    except (KeyboardInterrupt, ExternalShutdownException):
        pass


if __name__ == '__main__':
    main()
