// node src/motionPlan.test.js — 경로 미리보기 순서 확인 (CI web 작업에서 실행)
import assert from 'node:assert/strict'
import { checkMotion, motionPlan } from './motionPlan.js'

const J = ['j1', 'j2']
const n = (id, type, data = {}) => ({ id, type, data })
const e = (source, target, sourceHandle) => ({ source, target, ...(sourceHandle ? { sourceHandle } : {}) })
const mj = (id, a, b) => n(id, 'move_j', { joints: [a, b] })
const segs = (p) => p.segments.map(([a, b]) => `${a}>${b}`).sort()

// 직선: 동작 사이의 대기·그리퍼는 건너뛰어 이음, 도 → 라디안, 홈은 프로파일 home
let p = motionPlan({
  nodes: [n('s', 'start'), mj('a', 90, 0), n('w', 'wait'), n('g', 'gripper'), mj('b', 0, 45), n('h', 'move_home')],
  edges: [e('s', 'a'), e('a', 'w'), e('w', 'g'), e('g', 'b'), e('b', 'h')],
}, J, [10, 20])
assert.deepEqual(p.waypoints.map((w) => w.id), ['a', 'b', 'h'])
assert.ok(Math.abs(p.waypoints[0].pose.j1 - Math.PI / 2) < 1e-9 && Math.abs(p.waypoints[2].pose.j2 - (20 * Math.PI) / 180) < 1e-9)
assert.deepEqual(segs(p), ['a>b', 'b>h'])

// 분기(예/아니오)와 반복으로 되돌아가는 선, 병렬 갈래
p = motionPlan({
  nodes: [n('s', 'start'), n('l', 'loop'), mj('ap', 1, 1), n('v', 'vlm_check'), mj('pk', 2, 2), mj('rt', 3, 3), mj('end', 0, 0)],
  edges: [e('s', 'l'), e('l', 'ap', 'repeat'), e('l', 'end', 'done'), e('ap', 'v'), e('v', 'pk', 'yes'), e('v', 'rt', 'no'), e('pk', 'l'), e('rt', 'l')],
}, J)
assert.deepEqual(segs(p), ['ap>pk', 'ap>rt', 'pk>ap', 'pk>end', 'rt>ap', 'rt>end'])

// 시작에서 닿지 않는 동작, 관절 값이 잘못된 동작, 관절 수가 다른 동작은 빠지고 그 너머로 이어 붙이지 않음
p = motionPlan({
  nodes: [n('s', 'start'), mj('a', 1, 1), n('bad', 'move_j', { joints: [1, ''] }), n('short', 'move_j', { joints: [1] }), mj('c', 2, 2), mj('lost', 5, 5)],
  edges: [e('s', 'a'), e('a', 'bad'), e('bad', 'short'), e('short', 'c')],
}, J)
assert.deepEqual(p.waypoints.map((w) => w.id), ['a', 'c'])
assert.deepEqual(segs(p), ['a>c']) // 잘못된 블록은 동작으로 안 치고 건너뜀

// 웹이 궤적을 모르는 '녹화 동작 재생'에서는 선이 끊김, 관절 이름을 모르면(연결 전) 경로 없음
p = motionPlan({ nodes: [n('s', 'start'), mj('a', 1, 1), n('r', 'play_episode'), mj('b', 2, 2)], edges: [e('s', 'a'), e('a', 'r'), e('r', 'b')] }, J)
assert.deepEqual(segs(p), [])
assert.deepEqual(motionPlan({ nodes: [n('s', 'start'), mj('a', 1, 1)], edges: [e('s', 'a')] }, []).waypoints, [])

// 이동 시간: 블록 값, 없으면 기본값 (MoveJ 2초, 홈 3초)
p = motionPlan({ nodes: [n('s', 'start'), n('a', 'move_j', { joints: [0, 0], duration: 1.2 }), n('h', 'move_home')], edges: [e('s', 'a'), e('a', 'h')] }, J, [0, 0])
assert.deepEqual(p.waypoints.map((w) => w.duration), [1.2, 3])

// 동작 점검: 관절 범위·속도 한계 (최고 속도 = 1.5 × 평균), 같은 블록에 들어오는 구간이 여럿이면 가장 긴 필요 시간
const lim = { j1: { lower: -Math.PI, upper: Math.PI, velocity: 1 }, j2: { lower: -1, upper: 1, velocity: 1 } }
const plan = (wps, segments) => ({ waypoints: wps.map(([id, j1, j2, duration = 1]) => ({ id, pose: { j1, j2 }, duration })), segments })
let is = checkMotion(plan([['a', 0, 0], ['b', 0.6, 0], ['c', 0, 1.5]], [['a', 'b'], ['b', 'c']]), lim)
assert.deepEqual(is.map((i) => `${i.level} ${i.node} ${i.text}`), [
  'error c j2 86°: 범위(-57~57°) 밖입니다',
  'error c 너무 빠릅니다(j2). 이동 시간을 2.3초 이상으로 하세요', // 1.5 × 1.5 rad / 1 rad/s = 2.25 → 2.3
]) // a→b: 1.5 × 0.6 / 1 = 0.9초 ≤ 1초라 통과
is = checkMotion(plan([['a', 0, 0], ['x', 1, 0], ['b', 0.5, 0, 0.5]], [['a', 'b'], ['x', 'b']]), lim)
assert.deepEqual(is.map((i) => i.text), ['너무 빠릅니다(j1). 이동 시간을 0.8초 이상으로 하세요']) // max(0.75, 0.75)
assert.deepEqual(checkMotion(plan([['a', 0, 0], ['b', 3, 0]], [['a', 'b']]), {}), []) // 한계를 모르면 검사 안 함

// 작업 셀: 팔 끝(여기선 tip = [j1, 0, j2] m로 둔 가짜 순기구학)이 물체 안에 들어가면 주의. 지나가는 길도 본다
const cell = {
  tipAt: (pose) => [pose.j1, 0, pose.j2],
  obstacles: [
    { name: '작업대', shape: 'box', size: [2, 2, 0.1], xyz: [0, 0, -0.05] }, // 윗면 z = 0
    { name: '기둥', shape: 'cylinder', radius: 0.1, height: 1, xyz: [0.5, 0, 0.5] },
    { name: '부품', shape: 'cylinder', radius: 0.1, height: 0.1, xyz: [-0.5, 0, 0.05], obstacle: false }, // 집는 대상은 제외
    { name: '받침', shape: 'mesh', file: 'x.stl' }, // 모양 모름 → 건너뜀
    { name: '돌린 상자', shape: 'box', size: [0.4, 0.1, 0.1], xyz: [-0.5, 0, 0.6], rpy: [0, 0, Math.PI / 2] }, // 90° 돌아 x 폭 0.1
  ],
}
is = checkMotion(plan([['a', 0.2, 0.3], ['b', 0.8, 0.3], ['c', 0.2, -0.02], ['d', -0.5, 0.05], ['e', -0.5, 0.6], ['f', -0.62, 0.6]],
  [['a', 'b'], ['b', 'c'], ['c', 'd']]), {}, cell)
assert.deepEqual(is.map((i) => `${i.level} ${i.node} ${i.text}`), [
  'warn c 목표 자세에서 팔 끝이 작업대에 닿습니다',
  'warn e 목표 자세에서 팔 끝이 돌린 상자에 닿습니다',
  'warn b 가는 길에 팔 끝이 기둥에 닿습니다', // a→b 가 x = 0.5 기둥을 지나감 (끝점 b는 기둥 밖)
  'warn d 가는 길에 팔 끝이 작업대에 닿습니다', // 작업대 안(c)에서 출발하는 구간
]) // d: 부품 안이지만 obstacle: false, f: 돌린 상자는 x 폭 0.1 → -0.62는 밖

console.log('motionPlan OK')
