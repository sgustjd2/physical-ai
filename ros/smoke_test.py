"""스모크 테스트: 기동 중인 스택(실행기 + 모의 팔)에 워크플로를 보내고 결과를 확인한다.

  docker compose exec ros bash -c "source /opt/ros/jazzy/setup.bash && cd /ros && python3 smoke_test.py"
"""
import json
import math
import time

import rclpy
from rclpy.qos import DurabilityPolicy, QoSProfile
from sensor_msgs.msg import JointState
from std_msgs.msg import Bool, Empty, String

from workflow_executor import next_node, parse_value

# 순수 함수
g = {'edges': [{'source': 'a', 'target': 'b'}, {'source': 'b', 'target': 'a'}]}
assert next_node(g, 'a') == 'b' and next_node(g, 'b') == 'a' and next_node(g, 'c') is None
assert parse_value('true') is True and parse_value('3.5') == 3.5 and parse_value('abc') == 'abc'

rclpy.init()
node = rclpy.create_node('smoke_test')
states, joints = [], {}
latched = QoSProfile(depth=1, durability=DurabilityPolicy.TRANSIENT_LOCAL)
node.create_subscription(String, '/workflow/status', lambda m: states.append(json.loads(m.data)), latched)
node.create_subscription(JointState, '/joint_states', lambda m: joints.update(zip(m.name, m.position)), 10)
run = node.create_publisher(String, '/workflow/run', 10)
stop = node.create_publisher(Empty, '/workflow/stop', 10)
flag = node.create_publisher(Bool, '/smoke/flag', 10)


def spin_until(pred, timeout):
    t_end = time.monotonic() + timeout
    while not pred():
        assert time.monotonic() < t_end, f'timeout, states={states[-3:]}'
        rclpy.spin_once(node, timeout_sec=0.05)


def send(nodes, edges):
    states.clear()
    run.publish(String(data=json.dumps({'nodes': nodes, 'edges': edges})))


spin_until(lambda: run.get_subscription_count() and joints and states, 10)

# 1) start → move_j → wait_topic(외부 신호) → publish → 끝
target = [10, 20, 30, 0, 45, 0]
send([{'id': 's', 'type': 'start'},
      {'id': 'm', 'type': 'move_j', 'data': {'joints': target, 'duration': 0.5}},
      {'id': 'w', 'type': 'wait_topic', 'data': {'topic': '/smoke/flag', 'field': 'data', 'op': '==', 'value': 'true', 'timeout': 5}},
      {'id': 'p', 'type': 'publish', 'data': {'topic': '/smoke/out', 'type': 'std_msgs/Bool', 'data': '{"data": true}'}}],
     [{'source': 's', 'target': 'm'}, {'source': 'm', 'target': 'w'}, {'source': 'w', 'target': 'p'}])
spin_until(lambda: states and states[-1]['node'] == 'w', 5)
# 실행기가 방금 만든 구독이 디스커버리될 때까지 계속 보낸다
spin_until(lambda: flag.publish(Bool(data=True)) or states[-1]['state'] in ('done', 'error'), 10)
assert states[-1]['state'] == 'done', states[-1]
got = [math.degrees(joints[n]) for n in states[-1]['joints']]
assert all(abs(a - b) < 0.5 for a, b in zip(got, target)), got

# 2) 순환 그래프는 정지할 때까지 반복
send([{'id': 's', 'type': 'start'}, {'id': 'w', 'type': 'wait', 'data': {'sec': 0.05}}],
     [{'source': 's', 'target': 'w'}, {'source': 'w', 'target': 'w'}])
spin_until(lambda: len(states) >= 3, 5)
stop.publish(Empty())
spin_until(lambda: states[-1]['state'] == 'stopped', 5)

# 3) 잘못된 노드는 error 상태로 보고
send([{'id': 's', 'type': 'start'}, {'id': 'x', 'type': 'move_j', 'data': {'joints': [1, 2]}}],
     [{'source': 's', 'target': 'x'}])
spin_until(lambda: states and states[-1]['state'] == 'error', 5)

print('smoke test OK')
