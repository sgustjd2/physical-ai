"""check_dataset 의 점검 규칙 시험 (LeRobot 없이 배열만으로). python test_check.py"""
import numpy as np

from check_dataset import check_frames, check_motion

FPS = 10
J = ['a', 'b']
LIM = {'a': (-1.0, 1.0, 2.0)}  # b는 한계 없음 → 검사 안 함


def episode(n=6):
    s = np.stack([np.linspace(0, 0.5, n), np.zeros(n)], axis=1).astype(np.float32)
    act = np.concatenate([s[1:], s[-1:]])  # next_state: 다음 프레임 상태, 마지막은 유지
    return s, act, np.arange(n) / FPS, np.arange(n)


def run(s, a, t, fi, mode='next_state'):
    return check_motion(s, a, t, fi, FPS, mode, J, LIM)


s, a, t, fi = episode()
assert run(s, a, t, fi) == [], run(s, a, t, fi)

# action이 한 칸 밀림 (시간 정렬 실수) → 잡아냄
assert any('다음 프레임 상태와 다름' in p for p in run(s, s, t, fi))
# 마지막 action이 현재 자세가 아님
a2 = a.copy()
a2[-1, 0] = 0.9
assert any('마지막 프레임 action' in p for p in run(s, a2, t, fi))
# 리더 팔 토픽을 action으로 쓰는 모드에서는 next_state 검사를 하지 않음
assert run(s, s, t, fi, mode='/leader/joint_states') == []

# 프레임 간격·번호
assert any('프레임 간격' in p for p in run(s, a, t * 1.5, fi))
assert any('frame_index' in p for p in run(s, a, t, fi[::-1].copy()))

# 관절 한계 밖, 속도 한계 초과 (0 → 0.9 rad 를 0.1초에 = 9 rad/s > 2*1.5), NaN
s3, a3, _, _ = episode()
s3[2, 0] = 1.2
assert any('관절 한계' in p for p in run(s3, np.concatenate([s3[1:], s3[-1:]]), t, fi))
s4 = s.copy()
s4[3:, 0] = 0.9
assert any('속도' in p for p in run(s4, np.concatenate([s4[1:], s4[-1:]]), t, fi))
s5 = s.copy()
s5[1, 1] = np.nan
assert any('NaN' in p for p in run(s5, np.concatenate([s5[1:], s5[-1:]]), t, fi))
assert run(s[:1], a[:1], t[:1], fi[:1]) == ['프레임이 1개뿐']

# 카메라: 정상 / 단색 / 멈춤
rng = np.random.default_rng(0)
moving = [rng.random((3, 4, 5)).astype(np.float32) for _ in range(3)]
assert check_frames(moving) == []
assert any('단색' in w for w in check_frames([np.full((3, 4, 5), 0.2, np.float32)] + moving))
assert any('그대로' in w for w in check_frames([moving[0]] * 3))

print('test_check OK')
