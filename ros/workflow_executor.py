"""워크플로 실행기: 웹 노드 에디터에서 만든 그래프를 받아 노드를 순서대로 실행한다.

토픽 (std_msgs/String 안에 JSON):
  /workflow/run    ← {"nodes": [{id, type, data}], "edges": [{source, target}]}
  /workflow/stop   ← std_msgs/Empty
  /workflow/status → {"state": idle|running|done|error|stopped, "node": id, "msg": str, "joints": [이름]}

노드 타입: start, move_j, wait, wait_topic, publish
start에서 출발해 나가는 엣지를 따라간다. 엣지가 앞 노드로 돌아가면 반복(정지 버튼까지).
"""
import json
import math
import operator
import threading
import time

import rclpy
from action_msgs.msg import GoalStatus
from builtin_interfaces.msg import Duration
from control_msgs.action import FollowJointTrajectory
from rclpy.action import ActionClient
from rclpy.node import Node
from rclpy.qos import DurabilityPolicy, QoSProfile
from rosidl_runtime_py.set_message import set_message_fields
from rosidl_runtime_py.utilities import get_message
from std_msgs.msg import Empty, String
from trajectory_msgs.msg import JointTrajectoryPoint

OPS = {'==': operator.eq, '!=': operator.ne, '>': operator.gt,
       '<': operator.lt, '>=': operator.ge, '<=': operator.le}


def next_node(graph, node_id):
    """다음 노드 id, 나가는 엣지가 없으면 None. (웹이 노드당 나가는 엣지를 하나로 제한함)"""
    return next((e['target'] for e in graph['edges'] if e['source'] == node_id), None)


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


class Stopped(Exception):
    pass


class WorkflowExecutor(Node):
    def __init__(self):
        super().__init__('workflow_executor')
        self.joints = self.declare_parameter('joints', [f'joint{i}' for i in range(1, 7)]).value
        action = self.declare_parameter('trajectory_action', '/arm_controller/follow_joint_trajectory').value
        self.arm = ActionClient(self, FollowJointTrajectory, action)
        self.stop = threading.Event()
        self.thread = None
        self.pubs = {}
        latched = QoSProfile(depth=1, durability=DurabilityPolicy.TRANSIENT_LOCAL)
        self.status_pub = self.create_publisher(String, '/workflow/status', latched)
        self.create_subscription(String, '/workflow/run', self.on_run, 10)
        self.create_subscription(Empty, '/workflow/stop', lambda _: self.stop.set(), 10)
        self.status('idle')

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
        node_id = None
        try:
            nodes = {n['id']: n for n in graph['nodes']}
            start = next((n['id'] for n in graph['nodes'] if n['type'] == 'start'), None)
            if start is None:
                raise ValueError('시작 노드가 없음')
            node_id = next_node(graph, start)
            while node_id is not None:
                node = nodes[node_id]
                self.status('running', node_id)
                self.step(node['type'], node.get('data') or {})
                node_id = next_node(graph, node_id)
            self.status('done')
        except Stopped:
            self.status('stopped', node_id)
        except Exception as e:  # noqa: BLE001 — 어떤 실패든 웹에 보여준다
            self.get_logger().error(f'{node_id}: {e!r}')
            self.status('error', node_id, f'{type(e).__name__}: {e}')

    def step(self, kind, d):
        if kind == 'move_j':
            self.move_j([math.radians(float(v)) for v in d['joints']], float(d.get('duration', 2)))
        elif kind == 'wait':
            if self.stop.wait(float(d['sec'])):
                raise Stopped
        elif kind == 'wait_topic':
            self.wait_topic(d['topic'], d.get('field', ''), d.get('op', '=='),
                            parse_value(d.get('value')), float(d.get('timeout') or 0))
        elif kind == 'publish':
            self.publish(d['topic'], d['type'], json.loads(d.get('data') or '{}'))
        else:
            raise ValueError(f'알 수 없는 노드 타입: {kind}')

    def wait_until(self, done, timeout=0):
        """done()이 참이 될 때까지 대기. 정지 요청이면 Stopped, 시간 초과면 TimeoutError."""
        t_end = time.monotonic() + timeout if timeout else math.inf
        while not done():
            if self.stop.wait(0.02):
                raise Stopped
            if time.monotonic() > t_end:
                raise TimeoutError(f'{timeout}초 시간 초과')

    def move_j(self, positions, duration):
        if len(positions) != len(self.joints):
            raise ValueError(f'조인트 값 {len(positions)}개, 필요 {len(self.joints)}개')
        if not self.arm.wait_for_server(timeout_sec=2):
            raise RuntimeError('로봇팔 액션 서버 응답 없음')
        goal = FollowJointTrajectory.Goal()
        goal.trajectory.joint_names = self.joints
        goal.trajectory.points = [JointTrajectoryPoint(
            positions=positions,
            time_from_start=Duration(sec=int(duration), nanosec=int(duration % 1 * 1e9)))]
        future = self.arm.send_goal_async(goal)
        self.wait_until(future.done)
        handle = future.result()
        if not handle.accepted:
            raise RuntimeError('로봇팔이 목표를 거부함')
        future = handle.get_result_async()
        try:
            self.wait_until(future.done)
        except Stopped:
            handle.cancel_goal_async()  # 소프트웨어 정지일 뿐, 비상정지(E-stop)를 대신하지 않는다
            raise
        res = future.result()
        if res.status != GoalStatus.STATUS_SUCCEEDED or res.result.error_code != 0:
            raise RuntimeError(res.result.error_string or f'이동 실패 (status={res.status})')

    def wait_topic(self, topic, field, op, want, timeout):
        types = dict(self.get_topic_names_and_types())
        if topic not in types:
            raise RuntimeError(f'토픽 없음: {topic}')
        hit, err = threading.Event(), []

        def cb(m):
            try:
                ok = OPS[op](get_field(m, field), want)
            except Exception as e:  # noqa: BLE001 — 콜백 예외는 spin을 죽이므로 실행 스레드로 넘긴다
                err.append(e)
                ok = True
            if ok:
                hit.set()

        sub = self.create_subscription(msg_class(types[topic][0]), topic, cb, 10)
        try:
            self.wait_until(hit.is_set, timeout)
        finally:
            self.destroy_subscription(sub)
        if err:
            raise err[0]

    def publish(self, topic, type_name, data):
        cls = msg_class(type_name)
        msg = cls()
        set_message_fields(msg, data)
        key = (topic, type_name)
        if key not in self.pubs:
            self.pubs[key] = pub = self.create_publisher(cls, topic, 10)
            # ponytail: 새 퍼블리셔는 디스커버리 전에 보낸 메시지를 잃으므로 구독자를 최대 1초 기다림
            t_end = time.monotonic() + 1
            while pub.get_subscription_count() == 0 and time.monotonic() < t_end:
                time.sleep(0.05)
        self.pubs[key].publish(msg)


def main():
    rclpy.init()
    rclpy.spin(WorkflowExecutor())


if __name__ == '__main__':
    main()
