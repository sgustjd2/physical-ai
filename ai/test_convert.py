"""변환기 테스트: 합성 녹화(관절 + 카메라)를 만들어 변환하고, LeRobotDataset으로 다시 읽어 확인한다.

  python test_convert.py
"""
import io
import json
import tempfile
from pathlib import Path

import numpy as np
from mcap_ros2.writer import Writer
from PIL import Image

from convert_lerobot import convert
from lerobot.datasets.lerobot_dataset import LeRobotDataset

HEADER_DEFS = """
================================================================================
MSG: std_msgs/Header
builtin_interfaces/Time stamp
string frame_id
================================================================================
MSG: builtin_interfaces/Time
int32 sec
uint32 nanosec"""
JOINT_STATE = 'std_msgs/Header header\nstring[] name\nfloat64[] position\nfloat64[] velocity\nfloat64[] effort' + HEADER_DEFS
COMPRESSED = 'std_msgs/Header header\nstring format\nuint8[] data' + HEADER_DEFS
HDR = {'stamp': {'sec': 0, 'nanosec': 0}, 'frame_id': ''}
T0 = 1_700_000_000_000_000_000


def jpeg(color):
    b = io.BytesIO()
    Image.new('RGB', (32, 24), color).save(b, 'JPEG')
    return b.getvalue()


def make_episode(root, name, task, result, seconds=2.0, bunch=False):
    d = root / 'episodes' / name
    (d / 'bag').mkdir(parents=True)
    (d / 'episode.json').write_text(json.dumps(
        {'name': name, 'task': task, 'result': result, 'robot': 'test_arm'}, ensure_ascii=False), encoding='utf-8')
    with open(d / 'bag' / 'bag_0.mcap', 'wb') as f:
        w = Writer(f)
        js = w.register_msgdef('sensor_msgs/msg/JointState', JOINT_STATE)
        cam = w.register_msgdef('sensor_msgs/msg/CompressedImage', COMPRESSED)
        msgs = []
        for k in range(int(seconds * 50)):  # 관절 50Hz: 드라이버처럼 이름 순서를 섞고 그리퍼 관절도 끼운다
            p, t = k * 0.01, T0 + k * 20_000_000
            hdr, log = HDR, t
            if bunch:  # 측정 시각은 정확한데, 0.6~0.9초 사이 메시지가 녹화기에 0.9초에 한꺼번에 들어옴 (CPU 몰림)
                hdr = {'stamp': {'sec': t // 1_000_000_000, 'nanosec': t % 1_000_000_000}, 'frame_id': ''}
                log = T0 + 900_000_000 if 30 <= k <= 45 else t
            msgs.append((log, '/joint_states', js,
                         {'header': hdr, 'name': ['b', 'gripper', 'a'], 'position': [-p, 0.5, p], 'velocity': [], 'effort': []}))
        for k in range(int(seconds * 15)):  # 카메라 15Hz
            msgs.append((T0 + k * 66_666_667, '/cam', cam, {'header': HDR, 'format': 'jpeg', 'data': jpeg((k * 8 % 255, 40, 40))}))
        for t, topic, schema, m in sorted(msgs, key=lambda x: x[0]):
            w.write_message(topic, schema, m, log_time=t, publish_time=t)
        w.finish()


with tempfile.TemporaryDirectory() as tmp:
    root = Path(tmp)
    (root / 'robots' / 'test_arm').mkdir(parents=True)
    (root / 'robots' / 'test_arm' / 'robot.yaml').write_text(
        'joints: [a, b]\ntrajectory_action: /x\ndataset:\n  fps: 10\n  action: next_state\n  cameras:\n    front: /cam\n',
        encoding='utf-8')
    make_episode(root, 'ep1', '빨간 블록 집기', 'success')
    make_episode(root, 'ep2', '빨간 블록 집기', 'fail')
    make_episode(root, 'ep3', '', 'success')

    used = convert([root / 'episodes'], root / 'out', 'local/test', root / 'robots')
    assert [u['source'] for u in used] == ['ep1'], used

    ds = LeRobotDataset('local/test', root=root / 'out')
    assert ds.meta.info['codebase_version'] == 'v3.0', ds.meta.info
    assert ds.num_episodes == 1 and 18 <= ds.num_frames <= 20, (ds.num_episodes, ds.num_frames)
    f0, f1 = ds[0], ds[1]
    s0 = f0['observation.state'].numpy()
    assert s0.shape == (2,) and abs(s0[0] + s0[1]) < 1e-5, s0  # a=+p, b=-p → 이름으로 매핑됐는지
    assert np.allclose(f0['action'].numpy(), f1['observation.state'].numpy(), atol=1e-5)  # action = 다음 프레임 상태
    assert tuple(f0['observation.images.front'].shape) == (3, 24, 32), f0['observation.images.front'].shape
    assert f0['task'] == '빨간 블록 집기', f0['task']
    conv = json.loads((root / 'out' / 'conversion.json').read_text(encoding='utf-8'))
    assert {s['reason'] for s in conv['skipped']} == {'result=fail', 'task 없음'}, conv['skipped']

    # 변환 결과 점검기: 학습이 읽는 그대로 열어 시간·action·카메라·지시문 확인 (단색 합성 영상이라 주의는 나올 수 있음)
    from check_dataset import check_dataset
    from check_dataset import export_replays
    problems, _, lines, replays = check_dataset(root / 'out', root / 'robots')
    assert problems == [], problems
    assert len(lines) == 1, lines
    # 재생용 궤적: 학습 데이터의 action 그대로 (ROS '녹화 동작 재생' 블록이 읽음)
    rp = json.loads((export_replays(root / 'out', replays) / 'episode_000.json').read_text(encoding='utf-8'))
    assert rp['joints'] == ['a', 'b'] and rp['fps'] == 10 and len(rp['actions']) == ds.num_frames, rp.keys()
    assert np.allclose(rp['actions'][0], f0['action'].numpy(), atol=1e-5) and rp['task'] == '빨간 블록 집기'

    # 녹화 시각이 뭉친 관절 메시지: 측정 시각(header.stamp)으로 골라 프레임마다 같은 간격으로 움직여야 함
    from convert_lerobot import STATE_TOPIC, joints_of, snapshots
    make_episode(root, 'bunched', '몰림', 'success', bunch=True)
    a = [joints_of(s[STATE_TOPIC], ['a'])[0] for s in snapshots(root / 'episodes' / 'bunched' / 'bag', 10, {'front': '/cam'}, None)]
    assert len(a) > 15 and np.allclose(np.diff(a), 0.05, atol=1e-5), np.round(np.diff(a), 3)  # 50Hz × 0.01 → 10fps 한 프레임 0.05

print('test_convert OK')
