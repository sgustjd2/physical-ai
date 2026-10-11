"""워크플로 실행기: 웹 노드 에디터에서 만든 그래프를 받아 실행한다.

토픽 (std_msgs/String 안에 JSON):
  /workflow/run        ← {"nodes": [{id, type, data}], "edges": [{source, target, sourceHandle?}], "mode": "real"|"sim", "name"?}
                          name 이 있으면(웹의 실행·시뮬레이션 버튼) 운영 기록에 남긴다. 조그·홈·단계 시험은 남기지 않음
  /workflow/stop       ← std_msgs/Empty
  /workflow/estop      ← std_msgs/Bool  true = 비상정지(잠금), false = 해제. 잠긴 동안 실행·조그·홈 이동을 모두 거부
  /workflow/status     → {"state": idle|running|done|error|stopped, "node": id, "active": [id], "mode", "msg",
                          "joints", "home"(°), "estop", "camera"(프로파일 기본 카메라 토픽), "loop": [완료 반복, 전체] | null,
                          "elapsed": 실행 중이면 지금까지 초, 끝났으면 마지막 실행 소요 초 (조그 등은 세지 않음) | null}
  /workflow/node_types → [{type, label, group, icon, fields, outputs}]  (웹이 팔레트·입력 폼·출력 포트를 만드는 데 씀)
  /workflow/log        → {"entries": [{time, node, text}]}  최근 실행 기록 (시작·종료·AI 판단 근거 등, latched)
  /workflow/runs       → {"date", "today": {"real": 요약, "sim": 요약}, "yesterday": {...}, "days": [{date, real, sim}] 최근 28일(오래된 것부터),
                          "recent": [실행]}  운영 화면 KPI·기간 리포트 (latched)
                          요약 = {runs, done, stopped, error, avg_s(완료한 실행 평균 초), cycles(완료한 반복 수)}
                          실행 = {start, name, mode, state, seconds, cycles} — <data>/runs.jsonl 에 한 줄씩 쌓인다
  /robot_scene         → {"robot", "packages", "objects", "tcp"}  3D 작업 셀, URDF 메시 위치, 경로 미리보기의 팔 끝 링크 (로봇 프로파일의 scene·mesh_packages·tcp_link, latched)

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
from collections import defaultdict, deque
from datetime import date, datetime, timedelta
from pathlib import Path

import rclpy
from rclpy.executors import ExternalShutdownException
from rclpy.node import Node
from rclpy.qos import DurabilityPolicy, QoSProfile
from std_msgs.msg import Bool, Empty, String

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
        self.home = list(self.param('home', [0.0] * len(self.joints)))  # 홈 자세 (°), 로봇 프로파일
        self.camera = self.param('camera_topic', '')  # 웹 카메라 탭·AI 비전 판단의 기본 카메라
        self.estop_topic = self.param('estop_topic', '')  # 있으면 비상정지 상태를 드라이버/PLC 쪽으로도 알림 (Bool)
        self.estopped = False
        self.last_status = ('idle', None, '')
        self.stop = threading.Event()
        self.lock = threading.Lock()          # 실행 상태(활성 노드, 합류 카운터, 오류)
        self.entity_lock = threading.Lock()   # 병렬 갈래가 퍼블리셔/구독을 동시에 만들 때
        self.tls = threading.local()
        self.thread = None
        self.graph = None
        self.sim = False
        self.run_state = {}
        self.run_t0, self.run_elapsed, self.run_timed = None, None, False  # 상태의 elapsed (웹 시계와 무관하게 실행기 기준)
        self.cleanups = {}
        self.pubs = {}
        self.active = []
        self.last_node = None
        self.walkers = []
        self.errors = []
        self.status_pub = self.create_publisher(String, '/workflow/status', LATCHED)
        self.log_pub = self.create_publisher(String, '/workflow/log', LATCHED)
        self.log_entries = deque(maxlen=100)
        # 운영 기록: 실행 1건 = runs.jsonl 1줄 (앱은 지우지 않음). 오늘·어제 요약을 /workflow/runs 로
        self.runs_file = Path(self.param('runs_file', str(Path(__file__).resolve().parent.parent / 'data' / 'runs.jsonl')))
        self.runs = deque(load_runs(self.runs_file), maxlen=5000)  # ponytail: 최근 5000건만 메모리에 (하루 수천 건이면 늘림)
        self.runs_pub = self.create_publisher(String, '/workflow/runs', LATCHED)
        self.runs_day = None
        self.publish_runs()
        self.create_timer(60.0, lambda: self.runs_day != date.today().isoformat() and self.publish_runs())  # 자정 넘으면 '오늘'을 새로
        self.create_subscription(String, '/workflow/run', self.on_run, 10)
        self.create_subscription(Empty, '/workflow/stop', lambda _: self.stop.set(), 10)
        self.create_subscription(Bool, '/workflow/estop', self.on_estop, 10)
        self.estop_pub = self.create_publisher(Bool, self.estop_topic, LATCHED) if self.estop_topic else None

        for m in nodes.load_all():
            if hasattr(m, 'setup'):
                m.setup(self)
        specs = sorted((n['spec'] for n in nodes.REGISTRY.values()), key=lambda s: s['order'])
        self.create_publisher(String, '/workflow/node_types', LATCHED).publish(
            String(data=json.dumps(specs, ensure_ascii=False)))
        self.get_logger().info(f'노드 타입: {", ".join(nodes.REGISTRY)}')
        scene = json.loads(self.param('scene', '{}') or '{}')
        self.create_publisher(String, '/robot_scene', LATCHED).publish(String(data=json.dumps(
            {'robot': self.param('robot', ''), 'packages': scene.get('packages', {}), 'objects': scene.get('objects', []), 'tcp': scene.get('tcp', '')},
            ensure_ascii=False)))
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

    def log(self, text):
        with self.entity_lock:
            self.log_entries.append({'time': datetime.now().astimezone().isoformat(timespec='seconds'),
                                     'node': self.current, 'text': text})
            self.log_pub.publish(String(data=json.dumps({'entries': list(self.log_entries)}, ensure_ascii=False)))
        self.get_logger().info(text)

    # ---- 실행 ----
    def status(self, state, node=None, msg=''):
        self.last_status = (state, node, msg)
        data = {'state': state, 'node': node, 'active': list(self.active), 'msg': msg,
                'mode': 'sim' if self.sim else 'real', 'joints': self.joints, 'home': self.home, 'estop': self.estopped,
                'camera': self.camera, 'loop': self.run_state.get('progress'),
                'elapsed': (round(time.monotonic() - self.run_t0, 2) if self.run_timed else None) if state == 'running' else self.run_elapsed}
        self.status_pub.publish(String(data=json.dumps(data, ensure_ascii=False)))

    def on_estop(self, msg):
        """소프트웨어 비상정지: 진행 중인 동작을 즉시 취소하고, 해제할 때까지 새 실행을 거부한다.
        하드웨어 비상정지(안전 회로)를 대신하지 않는다 — estop_topic으로 드라이버/안전 PLC에 함께 알릴 뿐."""
        if msg.data == self.estopped:
            return
        self.estopped = msg.data
        if msg.data:
            self.stop.set()
        if self.estop_pub:
            self.estop_pub.publish(Bool(data=msg.data))
        self.tls.node = None
        self.log('비상정지' if msg.data else '비상정지 해제')
        with self.lock:
            self.status(*self.last_status)

    def on_run(self, msg):
        if self.estopped:
            self.status(self.last_status[0], self.last_status[1], '비상정지 상태입니다. 주변 안전을 확인하고 해제한 뒤 다시 시도하세요')
            return
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
        t0, started = time.monotonic(), datetime.now().astimezone()
        quiet = [n['id'] for n in graph.get('nodes', [])] == ['start', 'jog']  # 조그는 기록하지 않음
        self.run_timed = not quiet
        if not quiet:
            self.run_t0 = t0
            self.tls.node = None
            self.log(f'{"시뮬레이션" if self.sim else "실제 로봇"} 실행 시작')
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
        if not quiet:
            self.run_elapsed, self.run_timed = round(time.monotonic() - t0, 1), False
            self.tls.node = node_id
            label = {'done': '완료', 'stopped': '정지됨', 'error': f'오류: {err}'}[state]
            self.log(f'{label} ({time.monotonic() - t0:.1f}s)')
        if graph.get('name') and not quiet:
            self.record_run({'start': started.isoformat(timespec='seconds'), 'name': str(graph['name'])[:80], 'mode': 'sim' if self.sim else 'real',
                             'state': state, 'seconds': self.run_elapsed, 'cycles': self.run_state.get('cycles', 0)})
        self.status(state, node_id, err)

    def record_run(self, rec):
        try:
            self.runs_file.parent.mkdir(parents=True, exist_ok=True)
            with self.runs_file.open('a', encoding='utf-8') as f:
                f.write(json.dumps(rec, ensure_ascii=False) + '\n')
        except OSError as e:  # 기록 실패가 실행 결과를 바꾸지 않게
            self.get_logger().error(f'운영 기록 저장 실패: {e!r}')
        self.runs.append(rec)
        self.publish_runs()

    def publish_runs(self):
        today = date.today()
        self.runs_day = today.isoformat()
        runs = list(self.runs)
        by_day = defaultdict(list)  # 시작 시각의 날짜(YYYY-MM-DD)별
        for r in runs:
            by_day[str(r.get('start', ''))[:10]].append(r)
        days = [(today - timedelta(days=i)).isoformat() for i in range(27, -1, -1)]
        self.runs_pub.publish(String(data=json.dumps({
            'date': self.runs_day, 'today': summarize(by_day[days[-1]]), 'yesterday': summarize(by_day[days[-2]]),
            'days': [{'date': d, **summarize(by_day[d])} for d in days], 'recent': runs[-8:][::-1],
        }, ensure_ascii=False)))


def load_runs(path):
    """runs.jsonl → 실행 목록 (깨진 줄은 건너뜀)."""
    try:
        lines = path.read_text(encoding='utf-8').splitlines()
    except OSError:
        return []
    out = []
    for line in lines:
        try:
            out.append(json.loads(line))
        except ValueError:
            continue
    return out


def summarize(runs):
    """하루치 실행 → 요약 — 실제 로봇과 시뮬레이션 따로."""
    out = {}
    for mode in ('real', 'sim'):
        rs = [r for r in runs if r.get('mode') == mode]
        done = [r['seconds'] for r in rs if r.get('state') == 'done']
        out[mode] = {'runs': len(rs), 'done': len(done), 'stopped': sum(r.get('state') == 'stopped' for r in rs),
                     'error': sum(r.get('state') == 'error' for r in rs), 'avg_s': round(sum(done) / len(done), 1) if done else None,
                     'cycles': sum(int(r.get('cycles') or 0) for r in rs)}
    return out


def main():
    rclpy.init()
    try:
        rclpy.spin(WorkflowExecutor())
    except (KeyboardInterrupt, ExternalShutdownException):
        pass


if __name__ == '__main__':
    main()
