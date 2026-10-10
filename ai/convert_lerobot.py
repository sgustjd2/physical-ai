"""녹화된 에피소드(rosbag2 mcap + episode.json) → LeRobot Dataset v3.

  python convert_lerobot.py /data/episodes --out /data/lerobot/pick_v1
  python convert_lerobot.py /data/episodes/2026*_빨간* --out /data/lerobot/red --result success fail

- 로봇별 매핑(관절, 카메라, action 정의)은 robots/<robot>/robot.yaml 의 `dataset` 섹션에서 읽는다. 코드 수정 없음.
- ROS 설치 없이 동작한다 (mcap 파일 안에 메시지 스키마가 들어 있음).
- 프레임은 fps 간격으로 리샘플링: 각 프레임 시각 직전의 최신 메시지를 쓴다 (zero-order hold).
- 기본으로 result == success 인 에피소드만, 작업 설명(task)이 없는 에피소드는 건너뛴다 (VLA 지시문이 필요하므로).
"""
import argparse
import io
import json
import sys
from itertools import chain
from pathlib import Path

import numpy as np
import yaml
from mcap_ros2.reader import read_ros2_messages
from PIL import Image

from lerobot.datasets.lerobot_dataset import LeRobotDataset

ROOT = Path(__file__).resolve().parent.parent
STATE_TOPIC = '/joint_states'
CHANNELS = {'rgb8': 3, 'bgr8': 3, 'rgba8': 4, 'bgra8': 4, 'mono8': 1}


def load_profile(robots_dir, robot):
    cfg = yaml.safe_load((Path(robots_dir) / robot / 'robot.yaml').read_text(encoding='utf-8'))
    ds = cfg.get('dataset') or {}
    return {'joints': ds.get('joints') or cfg['joints'], 'fps': ds.get('fps', 30),
            'action': ds.get('action', 'next_state'), 'cameras': ds.get('cameras') or {}}


def joints_of(msg, joints):
    """JointState / JointTrajectory → 지정한 관절 순서의 위치 벡터. 드라이버의 관절 순서·추가 관절과 무관."""
    if hasattr(msg, 'points'):  # trajectory_msgs/JointTrajectory: 마지막 점 = 목표
        pos = dict(zip(msg.joint_names, msg.points[-1].positions))
    else:
        pos = dict(zip(msg.name, msg.position))
    missing = [j for j in joints if j not in pos]
    if missing:
        raise KeyError(f'메시지에 관절 없음: {missing} (있는 것: {list(pos)})')
    return np.array([pos[j] for j in joints], dtype=np.float32)


def to_rgb(msg):
    """sensor_msgs/CompressedImage 또는 Image → HxWx3 uint8."""
    if hasattr(msg, 'format'):
        return np.asarray(Image.open(io.BytesIO(bytes(msg.data))).convert('RGB'))
    c = CHANNELS.get(msg.encoding)
    if c is None:
        raise ValueError(f'지원하지 않는 이미지 인코딩: {msg.encoding} (지원: {list(CHANNELS)})')
    a = np.frombuffer(bytes(msg.data), np.uint8).reshape(msg.height, msg.step)[:, :msg.width * c]
    a = a.reshape(msg.height, msg.width, c)
    if msg.encoding.startswith('bgr'):
        a = a[..., [2, 1, 0]]
    return np.repeat(a, 3, axis=2) if c == 1 else np.ascontiguousarray(a[..., :3])


def snapshots(bag, fps, cameras, action_topic):
    """bag을 시간순으로 훑으며 1/fps 간격마다 {토픽: 그 시각 직전 최신 메시지} 를 낸다.
    상태와 모든 카메라가 한 번씩 들어온 시점부터 시작한다."""
    # ponytail: 녹화 시각(log_time) 기준 정렬. 카메라 드라이버 header.stamp 지연 보정은 필요해지면 추가
    required = [STATE_TOPIC, *cameras.values()]
    topics = required + ([action_topic] if action_topic else [])
    files = sorted(Path(bag).glob('*.mcap'))  # rosbag2는 크기/시간 기준으로 bag_0, bag_1… 로 나눠 쓴다
    if not files:
        raise FileNotFoundError(f'mcap 파일 없음: {bag}')
    latest, t_next, dt = {}, None, 1e9 / fps
    for m in chain.from_iterable(read_ros2_messages(str(f), topics=topics) for f in files):
        while t_next is not None and m.log_time_ns > t_next:
            yield dict(latest)
            t_next += dt
        latest[m.channel.topic] = m.ros_msg
        if t_next is None and all(t in latest for t in required):
            t_next = m.log_time_ns


def episode_frames(bag, prof, task):
    """LeRobot add_frame 에 넣을 프레임 dict 들. next_state 때문에 한 프레임 앞을 보며 흘려보낸다 (메모리 일정)."""
    joints, action_topic = prof['joints'], None if prof['action'] == 'next_state' else prof['action']
    prev = None
    for s in chain(snapshots(bag, prof['fps'], prof['cameras'], action_topic), [None]):
        if prev is not None:
            state = joints_of(prev[STATE_TOPIC], joints)
            if action_topic:  # 명령이 오기 전에는 현재 자세 유지가 목표
                act = joints_of(prev[action_topic], joints) if action_topic in prev else state
            else:  # 마지막 프레임은 다음이 없으므로 현재 자세 유지
                act = joints_of(s[STATE_TOPIC], joints) if s else state
            frame = {'observation.state': state, 'action': act, 'task': task}
            for name, topic in prof['cameras'].items():
                frame[f'observation.images.{name}'] = to_rgb(prev[topic])
            yield frame
        prev = s


def find_episodes(paths, results):
    eps, skipped = [], []
    for p in paths:
        p = Path(p)
        for d in sorted([p] if (p / 'episode.json').exists() else p.glob('*/')):
            if not (d / 'episode.json').exists():
                continue
            e = json.loads((d / 'episode.json').read_text(encoding='utf-8'))
            if e.get('result') not in results:
                skipped.append((d.name, f'result={e.get("result")}'))
            elif not e.get('task'):
                skipped.append((d.name, 'task 없음'))
            elif not (d / 'bag').is_dir():
                skipped.append((d.name, 'bag 없음'))
            else:
                eps.append((d, e))
    return eps, skipped


def convert(paths, out, repo_id=None, robots_dir=ROOT / 'robots', results=('success',)):
    eps, skipped = find_episodes(paths, results)
    for name, why in skipped:
        print(f'건너뜀 {name}: {why}')
    if not eps:
        raise SystemExit('변환할 에피소드가 없음')
    robots = {e['robot'] for _, e in eps}
    if len(robots) != 1:
        raise SystemExit(f'로봇이 다른 에피소드가 섞여 있음: {robots} (로봇별로 따로 변환)')
    robot = robots.pop()
    prof = load_profile(robots_dir, robot)

    first = None
    for d, e in eps:  # 카메라 해상도를 알아야 feature를 정할 수 있으므로 첫 프레임을 먼저 본다
        first = next(episode_frames(d / 'bag', prof, e['task']), None)
        if first:
            break
    if first is None:
        raise SystemExit('프레임을 만들 수 있는 에피소드가 없음 (상태/카메라 토픽이 녹화됐는지 확인)')

    n = len(prof['joints'])
    features = {
        'observation.state': {'dtype': 'float32', 'shape': (n,), 'names': prof['joints']},
        'action': {'dtype': 'float32', 'shape': (n,), 'names': prof['joints']},
    }
    for name in prof['cameras']:
        h, w, _ = first[f'observation.images.{name}'].shape
        features[f'observation.images.{name}'] = {'dtype': 'video', 'shape': (h, w, 3),
                                                  'names': ['height', 'width', 'channels']}

    out = Path(out)
    ds = LeRobotDataset.create(repo_id=repo_id or f'local/{out.name}', fps=prof['fps'], root=out,
                               robot_type=robot, features=features, use_videos=bool(prof['cameras']))
    used = []
    try:
        for d, e in eps:
            count = 0
            for frame in episode_frames(d / 'bag', prof, e['task']):
                ds.add_frame(frame)
                count += 1
            if count < 2:
                print(f'건너뜀 {d.name}: 프레임 {count}개')
                ds.clear_episode_buffer()
                continue
            ds.save_episode()
            used.append({'episode_index': len(used), 'source': d.name, 'task': e['task'],
                         'result': e['result'], 'frames': count})
            print(f'에피소드 {len(used) - 1}: {d.name} ({count} 프레임)')
    finally:
        ds.finalize()

    # 어떤 녹화에서 어떤 설정으로 만들었는지 (재현·추적용)
    (out / 'conversion.json').write_text(json.dumps(
        {'robot': robot, 'profile': prof, 'results': list(results), 'episodes': used,
         'skipped': [{'source': s, 'reason': r} for s, r in skipped]}, ensure_ascii=False, indent=2),
        encoding='utf-8')
    print(f'완료: {out} (에피소드 {len(used)}개, 프레임 {sum(u["frames"] for u in used)}개)')
    return used


def main():
    p = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    p.add_argument('paths', nargs='+', help='에피소드 폴더들 또는 그 상위 폴더 (예: /data/episodes)')
    p.add_argument('--out', required=True, help='만들 데이터셋 폴더 (없거나 비어 있어야 함)')
    p.add_argument('--repo-id', help='Hugging Face 저장소 이름 (기본: local/<out 폴더 이름>)')
    p.add_argument('--result', nargs='+', default=['success'], help='포함할 에피소드 결과 (기본: success)')
    p.add_argument('--robots-dir', default=ROOT / 'robots')
    a = p.parse_args()
    convert(a.paths, a.out, a.repo_id, a.robots_dir, tuple(a.result))


if __name__ == '__main__':
    sys.exit(main())
