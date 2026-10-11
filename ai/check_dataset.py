"""변환한 LeRobot 데이터셋 점검: 학습이 읽는 그대로 열어서 관측·행동이 맞는지 본다.

  python check_dataset.py /data/lerobot/pick_v1        # 문제가 있으면 종료 코드 1

문제(실패):
- 시간: frame_index가 0부터 연속, 프레임 간격이 1/fps
- 행동: action=next_state 이면 action[t] == state[t+1] (마지막 프레임은 현재 자세 유지)
- 관절: 값이 유한하고 URDF 관절 한계 안, 한 프레임 사이 이동이 속도 한계(1.5배 여유) 이하
- 카메라: 프레임이 디코딩되고 크기가 feature와 같음
- 지시문: 모든 프레임에 task
주의(통과, 확인 권장): 카메라 화면이 거의 단색(렌즈 덮개·검은 화면), 에피소드 내내 화면이 그대로(카메라 멈춤)

로봇·프로파일은 변환기가 남긴 conversion.json에서, 관절 한계는 robots/<robot>/robot.yaml 의 urdf에서 읽는다.

점검을 통과하면 에피소드마다 재생용 궤적을 <데이터셋>/replay/episode_NNN.json 으로 남긴다 (--no-export 로 끔).
ROS 쪽 '녹화 동작 재생' 블록이 이것으로 트윈(시뮬레이션) 또는 실제 팔에서 시연 동작을 다시 움직인다 — 학습이 보는 데이터 그대로.
"""
import argparse
import json
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

import numpy as np
import yaml

ROOT = Path(__file__).resolve().parent.parent
CAMERA_SAMPLES = 30  # 에피소드마다 디코딩해 보는 카메라 프레임 수 (전부 보면 큰 데이터셋에서 오래 걸림)


def urdf_limits(robots_dir, robot):
    """관절 이름 → (lower, upper, velocity). URDF가 없거나 한계가 없는 관절은 빠진다."""
    prof = Path(robots_dir) / robot / 'robot.yaml'
    if not prof.exists():
        return {}
    urdf = (yaml.safe_load(prof.read_text(encoding='utf-8')) or {}).get('urdf')
    if not urdf or not (prof.parent / urdf).exists():
        return {}
    out = {}
    for j in ET.parse(prof.parent / urdf).getroot().iter('joint'):
        lim = j.find('limit')
        if lim is not None and j.get('type') in ('revolute', 'prismatic'):
            out[j.get('name')] = (float(lim.get('lower', '-inf')), float(lim.get('upper', 'inf')), float(lim.get('velocity', 'inf')))
    return out


def check_motion(states, actions, timestamps, frame_index, fps, action_mode, joints, limits):
    """한 에피소드의 관절·시간·행동 점검 → 문제 문장 목록 (numpy 배열만 받으므로 단독으로 시험 가능)."""
    problems = []
    n = len(states)
    if n < 2:
        return [f'프레임이 {n}개뿐']
    if not np.array_equal(frame_index, np.arange(n)):
        problems.append('frame_index가 0부터 연속이 아님')
    gaps = np.diff(timestamps)
    if np.abs(gaps - 1 / fps).max() > 1e-3:
        problems.append(f'프레임 간격이 1/{fps}초가 아님 (최대 오차 {np.abs(gaps - 1 / fps).max():.4f}s)')
    for name, a in (('observation.state', states), ('action', actions)):
        if not np.isfinite(a).all():
            problems.append(f'{name}에 NaN/무한대')
    if action_mode == 'next_state':
        bad = np.where(np.abs(actions[:-1] - states[1:]).max(axis=1) > 1e-5)[0]
        if len(bad):
            problems.append(f'action이 다음 프레임 상태와 다름: 프레임 {bad[:5].tolist()}{" …" if len(bad) > 5 else ""} (action 정의 확인)')
        if np.abs(actions[-1] - states[-1]).max() > 1e-5:
            problems.append('마지막 프레임 action이 현재 자세가 아님')
    for i, j in enumerate(joints):
        if j not in limits:
            continue
        lo, hi, vel = limits[j]
        vals = np.concatenate([states[:, i], actions[:, i]])
        if vals.min() < lo - 1e-3 or vals.max() > hi + 1e-3:
            problems.append(f'{j}: 관절 한계 [{lo:.3f}, {hi:.3f}] 밖 ({vals.min():.3f} ~ {vals.max():.3f})')
        speed = np.abs(np.diff(states[:, i])).max() * fps
        if speed > vel * 1.5 + 1e-6:
            problems.append(f'{j}: 한 프레임 사이 속도 {speed:.2f} > 한계 {vel:.2f} (시간 정렬·끊김 의심)')
    return problems


def check_frames(frames):
    """카메라 표본 프레임들(C,H,W 0~1) → 주의 문장 목록."""
    warns = []
    if any(float(f.std()) < 0.01 for f in frames):
        warns.append('거의 단색인 화면이 있음 (렌즈 덮개·검은 화면?)')
    if len(frames) > 1 and max(float(np.abs(f - frames[0]).max()) for f in frames[1:]) < 0.01:
        warns.append('에피소드 내내 화면이 그대로 (카메라 멈춤?)')
    return warns


def check_dataset(root, robots_dir=ROOT / 'robots'):
    """→ (problems, warnings, 요약 줄들)"""
    from lerobot.datasets.lerobot_dataset import LeRobotDataset

    root = Path(root)
    conv = json.loads((root / 'conversion.json').read_text(encoding='utf-8'))
    prof = conv['profile']
    joints, fps = prof['joints'], prof['fps']
    limits = urdf_limits(robots_dir, conv['robot'])
    ds = LeRobotDataset(f'local/{root.name}', root=root)
    cams = [k for k, v in ds.meta.features.items() if v['dtype'] == 'video']
    tab = ds.hf_dataset.with_format('numpy')[:]
    problems, warnings, lines, replays = [], [], [], []
    for ep in range(ds.num_episodes):
        idx = np.where(tab['episode_index'] == ep)[0]
        p = [f'에피소드 {ep}: {m}' for m in check_motion(
            np.stack(tab['observation.state'][idx]), np.stack(tab['action'][idx]), tab['timestamp'][idx],
            tab['frame_index'][idx], fps, prof['action'], joints, limits)]
        w = []
        picks = idx[np.linspace(0, len(idx) - 1, min(CAMERA_SAMPLES, len(idx))).astype(int)] if len(idx) else []
        tasks = set()
        frames = {c: [] for c in cams}
        for i in picks:
            try:
                item = ds[int(i)]
            except Exception as e:  # noqa: BLE001 — 디코딩 실패도 점검 결과로 보고
                p.append(f'에피소드 {ep} 프레임 {int(i)}: 읽기 실패 {e!r}')
                break
            tasks.add(item['task'])
            for c in cams:
                f = item[c].numpy()
                h, wd = ds.meta.features[c]['shape'][:2]
                if f.shape != (3, h, wd):
                    p.append(f'에피소드 {ep} {c}: 크기 {f.shape} ≠ (3, {h}, {wd})')
                    break
                frames[c].append(f)
        if '' in tasks or not tasks:
            p.append(f'에피소드 {ep}: 지시문(task) 없음')
        for c in cams:
            w += [f'에피소드 {ep} {c}: {m}' for m in check_frames(frames[c])]
        problems += p
        warnings += w
        replays.append({'episode': ep, 'task': sorted(tasks)[0] if tasks else '', 'fps': fps, 'joints': joints,
                        'actions': np.stack(tab['action'][idx]).round(6).tolist(), 'source': root.name})
        lines.append(f'에피소드 {ep}: {len(idx)} 프레임 · {len(idx) / fps:.1f}s · {", ".join(sorted(tasks)) or "-"}'
                     f' · {"문제 " + str(len(p)) + "건" if p else "문제 없음"}{" · 주의 " + str(len(w)) + "건" if w else ""}')
    return problems, warnings, lines, replays


def export_replays(root, replays):
    """재생용 궤적 (관절 이름·fps·action[rad]) → <root>/replay/episode_NNN.json"""
    out = Path(root) / 'replay'
    out.mkdir(exist_ok=True)
    for r in replays:
        (out / f'episode_{r["episode"]:03d}.json').write_text(json.dumps(r, ensure_ascii=False), encoding='utf-8')
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('dataset', help='변환 결과 폴더 (conversion.json 이 있는 곳)')
    ap.add_argument('--robots', default=str(ROOT / 'robots'), help='로봇 프로파일 폴더 (관절 한계용 URDF)')
    ap.add_argument('--no-export', action='store_true', help='재생용 궤적(replay/)을 남기지 않음')
    a = ap.parse_args()
    problems, warnings, lines, replays = check_dataset(a.dataset, a.robots)
    print('\n'.join(lines))
    for w in warnings:
        print(f'주의 {w}')
    for p in problems:
        print(f'문제 {p}')
    print(f'점검 {"실패" if problems else "통과"}: 문제 {len(problems)}건, 주의 {len(warnings)}건')
    if not problems and not a.no_export:  # 문제 있는 데이터는 재생용으로 내보내지 않음
        print(f'재생용 궤적: {export_replays(a.dataset, replays)} ({len(replays)}개)')
    sys.exit(1 if problems else 0)


if __name__ == '__main__':
    main()
