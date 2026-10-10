"""워크플로 실행기: 웹 노드 에디터에서 만든 그래프를 받아 노드를 순서대로 실행한다.

토픽 (std_msgs/String 안에 JSON):
  /workflow/run        ← {"nodes": [{id, type, data}], "edges": [{source, target}]}
  /workflow/stop       ← std_msgs/Empty
  /workflow/status     → {"state": idle|running|done|error|stopped, "node": id, "msg": str, "joints": [이름]}
  /workflow/node_types → [{type, label, fields}]  (웹이 팔레트와 입력 폼을 만드는 데 씀)

이 파일은 그래프를 걷는 일만 한다. 노드 타입별 동작은 nodes/ 플러그인에 있다.
start에서 출발해 나가는 엣지를 따라가고, 엣지가 앞 노드로 돌아가면 반복(정지 버튼까지).
"""
import json
import math
import threading
import time

import rclpy
from rclpy.executors import ExternalShutdownException
from rclpy.node import Node
from rclpy.qos import DurabilityPolicy, QoSProfile
from std_msgs.msg import Empty, String

import nodes

LATCHED = QoSProfile(depth=1, durability=DurabilityPolicy.TRANSIENT_LOCAL)


def next_node(graph, node_id):
    """다음 노드 id, 나가는 엣지가 없으면 None. (웹이 노드당 나가는 엣지를 하나로 제한함)"""
    return next((e['target'] for e in graph['edges'] if e['source'] == node_id), None)


class Stopped(Exception):
    pass


class WorkflowExecutor(Node):
    def __init__(self):
        super().__init__('workflow_executor')
        self.joints = self.param('joints', [f'joint{i}' for i in range(1, 7)])
        self.stop = threading.Event()
        self.thread = None
        self.graph = None
        self.cleanups = {}
        self.pubs = {}
        self.status_pub = self.create_publisher(String, '/workflow/status', LATCHED)
        self.create_subscription(String, '/workflow/run', self.on_run, 10)
        self.create_subscription(Empty, '/workflow/stop', lambda _: self.stop.set(), 10)

        for m in nodes.load_all():
            if hasattr(m, 'setup'):
                m.setup(self)
        specs = [n['spec'] for n in nodes.REGISTRY.values()]
        self.create_publisher(String, '/workflow/node_types', LATCHED).publish(
            String(data=json.dumps(specs, ensure_ascii=False)))
        self.get_logger().info(f'노드 타입: {", ".join(nodes.REGISTRY)}')
        self.status('idle')

    # ---- 플러그인용 헬퍼 (nodes/__init__.py 참고) ----
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

        sub = self.create_subscription(msg_cls, topic, cb, qos)
        try:
            self.wait_until(lambda: hit or err, timeout)
        finally:
            self.destroy_subscription(sub)
        if err:
            raise err[0]
        return hit[0]

    def publish(self, topic, msg):
        key = (topic, type(msg))
        if key not in self.pubs:
            self.pubs[key] = pub = self.create_publisher(type(msg), topic, 10)
            # ponytail: 새 퍼블리셔는 디스커버리 전에 보낸 메시지를 잃으므로 구독자를 최대 1초 기다림
            t_end = time.monotonic() + 1
            while pub.get_subscription_count() == 0 and time.monotonic() < t_end:
                time.sleep(0.05)
        self.pubs[key].publish(msg)

    def on_finish(self, key, fn):
        self.cleanups[key] = fn

    # ---- 실행 ----
    def status(self, state, node=None, msg=''):
        data = {'state': state, 'node': node, 'msg': msg, 'joints': self.joints}
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

    def run(self, graph):
        self.graph, self.cleanups = graph, {}
        node_id, state, err = None, 'done', ''
        try:
            by_id = {n['id']: n for n in graph['nodes']}
            start = next((n['id'] for n in graph['nodes'] if n['type'] == 'start'), None)
            if start is None:
                raise ValueError('시작 노드가 없음')
            node_id = next_node(graph, start)
            while node_id is not None:
                n = by_id[node_id]
                if n['type'] not in nodes.REGISTRY:
                    raise ValueError(f'이 서버에 없는 노드 타입: {n["type"]}')
                self.status('running', node_id)
                nodes.REGISTRY[n['type']]['run'](self, n.get('data') or {})
                node_id = next_node(graph, node_id)
        except Stopped:
            state = 'stopped'
        except Exception as e:  # noqa: BLE001 — 어떤 실패든 웹에 보여준다
            self.get_logger().error(f'{node_id}: {e!r}')
            state, err = 'error', f'{type(e).__name__}: {e}'
        for fn in self.cleanups.values():
            try:
                fn(state)
            except Exception as e:  # noqa: BLE001
                self.get_logger().error(f'정리 실패: {e!r}')
        self.status(state, None if state == 'done' else node_id, err)


def main():
    rclpy.init()
    try:
        rclpy.spin(WorkflowExecutor())
    except (KeyboardInterrupt, ExternalShutdownException):
        pass


if __name__ == '__main__':
    main()
