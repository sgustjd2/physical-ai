// node src/motionPlan.test.js — 경로 미리보기 순서 확인 (CI web 작업에서 실행)
import assert from 'node:assert/strict'
import { motionPlan } from './motionPlan.js'

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

console.log('motionPlan OK')
