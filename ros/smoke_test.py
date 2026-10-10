"""스모크 테스트: 기동 중인 스택(실행기 + 저장소 + 녹화기 + 모의 팔 + 트윈 팔)에 워크플로를 보내고 결과를 확인한다.

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
states, joints, episode, types, library, sim_j1, logs, gen = [], {}, {}, [], {}, [], {}, {}
node.create_subscription(String, '/workflow/status', lambda m: states.append(json.loads(m.data)), LATCHED)
node.create_subscription(String, '/episode/status', lambda m: episode.update(json.loads(m.data)), LATCHED)
node.create_subscription(String, '/workflow/node_types', lambda m: types.extend(json.loads(m.data)), LATCHED)
node.create_subscription(JointState, '/joint_states', lambda m: joints.update(zip(m.name, m.position)), 10)
node.create_subscription(String, '/workflow/library', lambda m: library.update(json.loads(m.data)), LATCHED)
node.create_subscription(JointState, '/sim/joint_states', lambda m: sim_j1.append(math.degrees(m.position[0])), 10)
lib_cmd = node.create_publisher(String, '/workflow/library/cmd', 10)
node.create_subscription(String, '/workflow/log', lambda m: logs.update(json.loads(m.data)), LATCHED)
node.create_subscription(String, '/workflow/generate', lambda m: gen.update(json.loads(m.data)), LATCHED)
gen_cmd = node.create_publisher(String, '/workflow/generate/cmd', 10)
run = node.create_publisher(String, '/workflow/run', 10)
stop = node.create_publisher(Empty, '/workflow/stop', 10)
estop = node.create_publisher(Bool, '/workflow/estop', 10)
flag = node.create_publisher(Bool, '/smoke/flag', 10)


def spin_until(pred, timeout):
    t_end = time.monotonic() + timeout
    while not pred():
        assert time.monotonic() < t_end, f'timeout, states={states[-3:]}, episode.error={episode.get("error")}'
        rclpy.spin_once(node, timeout_sec=0.05)


def send(nodes, edges, mode='real'):
    states.clear()
    run.publish(String(data=json.dumps({'nodes': [{'id': 's', 'type': 'start'}, *nodes], 'edges': edges, 'mode': mode})))


def run_until_end(nodes, edges, timeout=15, mode='real'):
    send(nodes, edges, mode)
    spin_until(lambda: states and states[-1]['state'] in ('done', 'error', 'stopped'), timeout)
    return states[-1]


def visited():
    return [st['node'] for st in states if st['state'] == 'running']


def wait_node(id_, sec=0.3):
    return {'id': id_, 'type': 'wait', 'data': {'sec': sec}}


spin_until(lambda: run.get_subscription_count() and estop.get_subscription_count() and lib_cmd.get_subscription_count() and gen_cmd.get_subscription_count()
           and joints and states and episode and types and library and sim_j1 and gen, 30)
assert {'move_j', 'move_home', 'wait', 'wait_topic', 'publish', 'episode_start', 'episode_end', 'if', 'loop', 'join', 'gripper', 'vlm_check'} <= {t['type'] for t in types}
assert next(t for t in types if t['type'] == 'if')['outputs'] == [{'id': 'yes', 'label': '예'}, {'id': 'no', 'label': '아니오'}]

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

# 6) 조건 분기: 시뮬레이션에서 지정한 방향(아니오)으로 간다
end = run_until_end(
    [{'id': 'c', 'type': 'if', 'data': {'topic': '/x', 'sim_result': '아니오'}}, wait_node('wy'), wait_node('wn')],
    [{'source': 's', 'target': 'c'}, {'source': 'c', 'sourceHandle': 'yes', 'target': 'wy'},
     {'source': 'c', 'sourceHandle': 'no', 'target': 'wn'}], mode='sim')
assert end['state'] == 'done' and 'wn' in visited() and 'wy' not in visited(), visited()

# 7) 병렬 + 합류: 0.6초 두 갈래가 동시에 돌고, 합류 뒤 노드는 한 번만
t0 = time.monotonic()
end = run_until_end(
    [wait_node('a', 0.6), wait_node('b', 0.6), {'id': 'j', 'type': 'join'}, wait_node('after', 0.2)],
    [{'source': 's', 'target': 'a'}, {'source': 's', 'target': 'b'}, {'source': 'a', 'target': 'j'},
     {'source': 'b', 'target': 'j'}, {'source': 'j', 'target': 'after'}])
took = time.monotonic() - t0
assert end['state'] == 'done' and took < 1.2, (end, took)
assert any({'a', 'b'} <= set(st.get('active', [])) for st in states), [st.get('active') for st in states]
assert visited().count('after') == 1, visited()

# 8) 반복 3회
end = run_until_end(
    [{'id': 'l', 'type': 'loop', 'data': {'count': 3}}, wait_node('body', 0.2)],
    [{'source': 's', 'target': 'l'}, {'source': 'l', 'sourceHandle': 'repeat', 'target': 'body'},
     {'source': 'body', 'target': 'l'}])
assert end['state'] == 'done' and visited().count('body') == 3, visited()

# 9) 시뮬레이션 실행: 실제 팔은 그대로, 트윈 팔(/sim)만 목표로 간다
before = dict(joints)
sim_j1.clear()
end = run_until_end([{'id': 'm', 'type': 'move_j', 'data': {'joints': [30, 0, 0, 0, 0, 0], 'duration': 0.5}},
                     {'id': 'g', 'type': 'gripper', 'data': {'action': '닫기'}}],
                    [{'source': 's', 'target': 'm'}, {'source': 'm', 'target': 'g'}], mode='sim')
assert end['state'] == 'done' and end['mode'] == 'sim', end
assert all(abs(joints[n] - before[n]) < 0.01 for n in before), '시뮬레이션인데 실제 팔이 움직임'
assert max(sim_j1) > 29, max(sim_j1)

# 10) 서버 저장소: 저장 → 목록에 있음 → 삭제
graph = {'nodes': [{'id': 's', 'type': 'start'}], 'edges': []}
lib_cmd.publish(String(data=json.dumps({'op': 'save', 'id': 'sv1', 'name': '스모크 워크플로', 'graph': graph}, ensure_ascii=False)))
spin_until(lambda: library.get('ack') == 'sv1', 5)
assert not library['error'] and any(w['name'] == '스모크 워크플로' for w in library['items']), library
lib_cmd.publish(String(data=json.dumps({'op': 'delete', 'id': 'dl1', 'name': '스모크 워크플로'}, ensure_ascii=False)))
spin_until(lambda: library.get('ack') == 'dl1', 5)
assert not any(w['name'] == '스모크 워크플로' for w in library['items']), library

# 11) AI 비전 판단: 시뮬레이션에서는 AI를 부르지 않고 지정한 방향으로, 판단은 실행 기록에 남는다
end = run_until_end([{'id': 'v', 'type': 'vlm_check', 'data': {'question': '부품이 있나요?', 'sim_result': '아니오'}},
                     wait_node('vy'), wait_node('vn')],
                    [{'source': 's', 'target': 'v'}, {'source': 'v', 'sourceHandle': 'yes', 'target': 'vy'},
                     {'source': 'v', 'sourceHandle': 'no', 'target': 'vn'}], mode='sim')
assert end['state'] == 'done' and 'vn' in visited() and 'vy' not in visited(), visited()
spin_until(lambda: logs.get('entries') and '완료' in logs['entries'][-1]['text'], 5)
assert any('AI 판단 생략' in e['text'] for e in logs['entries']), logs['entries'][-3:]

# 12) AI 시나리오 생성기: 요청에 응답(ack)한다. API 키가 없는 환경이면 이유가 담긴 오류로 응답
gen_cmd.publish(String(data=json.dumps({'id': 'g1', 'prompt': '부품이 보이면 집어서 옮기기'}, ensure_ascii=False)))
spin_until(lambda: gen.get('ack') == 'g1', 120)
assert gen.get('graph') or gen.get('error'), gen
print('시나리오 생성기 응답:', '그래프 생성' if gen.get('graph') else gen['error'])

# 13) 홈 위치로 이동: 프로파일의 home 자세로 (상태에 home이 실려 웹 버튼이 씀)
end = run_until_end([{'id': 'm', 'type': 'move_j', 'data': {'joints': [20, 10, 0, 0, 0, 0], 'duration': 0.5}},
                     {'id': 'h', 'type': 'move_home', 'data': {'duration': 0.5}}],
                    [{'source': 's', 'target': 'm'}, {'source': 'm', 'target': 'h'}])
assert end['state'] == 'done' and len(end['home']) == len(end['joints']), end
got = [math.degrees(joints[n]) for n in end['joints']]
assert all(abs(a - b) < 0.5 for a, b in zip(got, end['home'])), got

# 14) 비상정지: 실행 중 즉시 정지 → 잠긴 동안 실행 거부 → 해제 후 다시 실행
send([{'id': 'w', 'type': 'wait', 'data': {'sec': 0.05}}], [{'source': 's', 'target': 'w'}, {'source': 'w', 'target': 'w'}])
spin_until(lambda: len(states) >= 3, 5)
estop.publish(Bool(data=True))
spin_until(lambda: states[-1]['state'] == 'stopped' and states[-1]['estop'], 5)
send([wait_node('w')], [{'source': 's', 'target': 'w'}])
spin_until(lambda: states and '비상정지' in states[-1]['msg'], 5)
assert not any(st['state'] == 'running' for st in states), states
estop.publish(Bool(data=False))
spin_until(lambda: states and not states[-1]['estop'], 5)
assert run_until_end([wait_node('w')], [{'source': 's', 'target': 'w'}])['state'] == 'done'

print('smoke test OK')
