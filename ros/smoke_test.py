"""스모크 테스트: 기동 중인 스택(실행기 + 녹화기 + 모의 팔)에 워크플로를 보내고 결과를 확인한다.

  docker compose exec ros bash -c "source /opt/ros/jazzy/setup.bash && cd /ros && python3 smoke_test.py"
"""
import json
import math
import time
from pathlib import Path

import rclpy
import yaml
from rclpy.qos import DurabilityPolicy, QoSProfile
from sensor_msgs.msg import JointState
from std_msgs.msg import Bool, Empty, String

from nodes.topics import parse_value
from workflow_executor import next_node

# 순수 함수
g = {'edges': [{'source': 'a', 'target': 'b'}, {'source': 'b', 'target': 'a'}]}
assert next_node(g, 'a') == 'b' and next_node(g, 'b') == 'a' and next_node(g, 'c') is None
assert parse_value('true') is True and parse_value('3.5') == 3.5 and parse_value('abc') == 'abc'

DATA = Path(__file__).resolve().parent.parent / 'data' / 'episodes'  # recorder.py 기본값과 같음
LATCHED = QoSProfile(depth=1, durability=DurabilityPolicy.TRANSIENT_LOCAL)

rclpy.init()
node = rclpy.create_node('smoke_test')
states, joints, episode, types = [], {}, {}, []
node.create_subscription(String, '/workflow/status', lambda m: states.append(json.loads(m.data)), LATCHED)
node.create_subscription(String, '/episode/status', lambda m: episode.update(json.loads(m.data)), LATCHED)
node.create_subscription(String, '/workflow/node_types', lambda m: types.extend(json.loads(m.data)), LATCHED)
node.create_subscription(JointState, '/joint_states', lambda m: joints.update(zip(m.name, m.position)), 10)
run = node.create_publisher(String, '/workflow/run', 10)
stop = node.create_publisher(Empty, '/workflow/stop', 10)
flag = node.create_publisher(Bool, '/smoke/flag', 10)


def spin_until(pred, timeout):
    t_end = time.monotonic() + timeout
    while not pred():
        assert time.monotonic() < t_end, f'timeout, states={states[-3:]}, episode.error={episode.get("error")}'
        rclpy.spin_once(node, timeout_sec=0.05)


def send(nodes, edges):
    states.clear()
    run.publish(String(data=json.dumps({'nodes': [{'id': 's', 'type': 'start'}, *nodes], 'edges': edges})))


def run_until_end(nodes, edges, timeout=15):
    send(nodes, edges)
    spin_until(lambda: states and states[-1]['state'] in ('done', 'error', 'stopped'), timeout)
    return states[-1]


spin_until(lambda: run.get_subscription_count() and joints and states and episode and types, 30)
assert {'move_j', 'wait', 'wait_topic', 'publish', 'episode_start', 'episode_end'} <= {t['type'] for t in types}

# 1) start → move_j → wait_topic(외부 신호) → publish → 끝
target = [10, 20, 30, 0, 45, 0]
send([{'id': 'm', 'type': 'move_j', 'data': {'joints': target, 'duration': 0.5}},
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
send([{'id': 'w', 'type': 'wait', 'data': {'sec': 0.05}}],
     [{'source': 's', 'target': 'w'}, {'source': 'w', 'target': 'w'}])
spin_until(lambda: len(states) >= 3, 5)
stop.publish(Empty())
spin_until(lambda: states[-1]['state'] == 'stopped', 5)

# 3) 잘못된 노드는 error 상태로 보고
end = run_until_end([{'id': 'x', 'type': 'move_j', 'data': {'joints': [1, 2]}}], [{'source': 's', 'target': 'x'}])
assert end['state'] == 'error', end

# 4) 에피소드 녹화: 시작 → 이동 → 성공 종료. bag 안에 관절 상태와 명령이 들어 있어야 함
end = run_until_end(
    [{'id': 'e1', 'type': 'episode_start', 'data': {'task': '스모크 테스트'}},
     {'id': 'm', 'type': 'move_j', 'data': {'joints': [0, 0, 0, 0, 0, 0], 'duration': 0.5}},
     {'id': 'e2', 'type': 'episode_end', 'data': {'result': 'success'}}],
    [{'source': 's', 'target': 'e1'}, {'source': 'e1', 'target': 'm'}, {'source': 'm', 'target': 'e2'}])
assert end['state'] == 'done', end
spin_until(lambda: not episode['recording'] and episode['episodes'], 5)
ep = episode['episodes'][0]
assert ep['task'] == '스모크 테스트' and ep['result'] == 'success', ep
meta = yaml.safe_load((DATA / ep['name'] / 'bag' / 'metadata.yaml').read_text())['rosbag2_bagfile_information']
counts = {t['topic_metadata']['name']: t['message_count'] for t in meta['topics_with_message_count']}
assert counts.get('/joint_states', 0) > 5 and counts.get('/workflow/command', 0) == 1, counts
info = json.loads((DATA / ep['name'] / 'episode.json').read_text(encoding='utf-8'))
assert info['robot'] and info['workflow']['nodes'], info.keys()

# 5) 에피소드 종료 없이 정지하면 'stopped'로 자동 종료
send([{'id': 'e1', 'type': 'episode_start', 'data': {'task': '자동 종료'}},
      {'id': 'w', 'type': 'wait', 'data': {'sec': 0.05}}],
     [{'source': 's', 'target': 'e1'}, {'source': 'e1', 'target': 'w'}, {'source': 'w', 'target': 'w'}])
spin_until(lambda: episode['recording'], 10)
stop.publish(Empty())
spin_until(lambda: not episode['recording'] and episode['episodes'][0]['task'] == '자동 종료', 10)
assert episode['episodes'][0]['result'] == 'stopped', episode['episodes'][0]

print('smoke test OK')
