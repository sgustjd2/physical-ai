// node src/check.test.js — 실행 전 점검 확인 (CI web 작업에서 실행)
import assert from 'node:assert/strict'
import { checkGraph } from './check.js'

const specs = {
  move_j: { fields: [{ key: 'joints', label: '관절 각도 (°)', kind: 'joints' }, { key: 'duration', label: '이동 시간 (s)', kind: 'number' }], outputs: [{ id: 'out' }], resource: 'arm' },
  move_home: { fields: [{ key: 'duration', label: '이동 시간 (s)', kind: 'number' }], outputs: [{ id: 'out' }], resource: 'arm' },
  gripper: { fields: [{ key: 'action', label: '동작', kind: 'select' }], outputs: [{ id: 'out' }], resource: 'gripper' },
  wait: { fields: [{ key: 'sec', label: '시간 (s)', kind: 'number' }], outputs: [{ id: 'out' }] },
  join: { fields: [], outputs: [{ id: 'out' }] },
  loop: { fields: [{ key: 'count', label: '반복 횟수', kind: 'number' }], outputs: [{ id: 'repeat' }, { id: 'done' }] },
  vlm_check: { fields: [], outputs: [{ id: 'yes', label: '예' }, { id: 'no', label: '아니오' }] },
  play_episode: { fields: [{ key: 'dataset', label: '데이터셋', kind: 'dataset' }, { key: 'episode', label: '에피소드', kind: 'episode' }], outputs: [{ id: 'out' }], resource: 'arm' },
}
const n = (id, type, data = {}) => ({ id, type, data })
const e = (source, target, sourceHandle) => ({ source, target, ...(sourceHandle ? { sourceHandle } : {}) })
const mj = (id) => n(id, 'move_j', { joints: [0, 0, 0], duration: 1 })
const levels = (issues) => issues.map((i) => `${i.level}:${i.node}`).sort()

// 문제없는 직선 흐름
assert.deepEqual(checkGraph({ nodes: [n('s', 'start'), mj('a'), n('w', 'wait', { sec: '1.5' })], edges: [e('s', 'a'), e('a', 'w')] }, specs, 3), [])

// 병렬로 팔 두 번 → 두 블록 모두 오류. 그리퍼 + 팔(다른 장비)은 괜찮음
let g = { nodes: [n('s', 'start'), mj('a'), n('h', 'move_home', { duration: 2 }), n('g', 'gripper', { action: '열기' })], edges: [e('s', 'a'), e('s', 'h'), e('s', 'g')] }
assert.deepEqual(levels(checkGraph(g, specs, 3)), ['error:a', 'error:h'])

// 합류 뒤의 팔 동작은 병렬이 아님 (예제: 그리퍼 열기 ∥ 홈 → 합류 → 이동)
g = { nodes: [n('s', 'start'), n('g', 'gripper', { action: '열기' }), n('h', 'move_home', { duration: 2 }), n('j', 'join'), mj('a')], edges: [e('s', 'g'), e('s', 'h'), e('g', 'j'), e('h', 'j'), e('j', 'a')] }
assert.deepEqual(checkGraph(g, specs, 3), [])

// 갈래 안 깊숙한 팔 동작도 찾음, 분기 포트(loop repeat)에 두 갈래
g = { nodes: [n('s', 'start'), n('l', 'loop', { count: 3 }), n('w', 'wait', { sec: 1 }), mj('a'), mj('b')], edges: [e('s', 'l'), e('l', 'w', 'repeat'), e('l', 'b', 'repeat'), e('w', 'a')] }
assert.deepEqual(levels(checkGraph(g, specs, 3)), ['error:a', 'error:b'])

// 관절 값·숫자 칸
g = { nodes: [n('s', 'start'), n('a', 'move_j', { joints: [0, '', 0], duration: 1 }), n('b', 'move_j', { joints: [0, 0], duration: 'x' }), n('w', 'wait', { sec: '' })], edges: [e('s', 'a'), e('a', 'b'), e('b', 'w')] }
const texts = checkGraph(g, specs, 3).map((i) => `${i.node}:${i.text}`)
assert.ok(texts.includes('a:비어 있거나 숫자가 아닌 관절 값이 있습니다'))
assert.ok(texts.includes('b:관절 값이 2개입니다 (로봇 관절 3개)'))
assert.ok(texts.includes("b:'이동 시간 (s)'에 숫자를 넣으세요"))
assert.ok(texts.includes("w:'시간 (s)'에 숫자를 넣으세요"))
assert.equal(checkGraph(g, specs, 0).filter((i) => i.text.includes('로봇 관절')).length, 0) // 관절 수 모르면 개수 검사 안 함

// 연결 안 된 블록은 경고만 (실행 경로가 아니므로 내용 오류는 보지 않음), 서버에 없는 블록은 실행 경로에 있을 때만 오류
g = { nodes: [n('s', 'start'), n('x', 'laser'), n('w', 'wait', { sec: 'bad' })], edges: [e('s', 'x')] }
assert.deepEqual(checkGraph(g, specs, 3).map((i) => `${i.level}:${i.node}`), ['error:x', 'warn:w'])

// 블록 목록을 아직 못 받았으면 타입·칸·장비 검사는 건너뜀 (거짓 오류 방지)
assert.deepEqual(levels(checkGraph(g, {}, 3)), ['warn:w'])

// 반복으로 되돌아가는 연결이 있어도 끝남
g = { nodes: [n('s', 'start'), n('l', 'loop', { count: 2 }), mj('a')], edges: [e('s', 'l'), e('l', 'a', 'repeat'), e('a', 'l')] }
assert.deepEqual(checkGraph(g, specs, 3), [])

// 녹화 동작 재생: 데이터셋을 안 고르면 오류, 고르면 통과 (에피소드 칸은 숫자 검사 대상 아님)
assert.deepEqual(checkGraph({ nodes: [n('s', 'start'), n('p', 'play_episode', { dataset: '', episode: 0 })], edges: [e('s', 'p')] }, specs, 3).map((i) => i.text), ["'데이터셋'을 고르세요"])
assert.deepEqual(checkGraph({ nodes: [n('s', 'start'), n('p', 'play_episode', { dataset: 'motion', episode: '0' })], edges: [e('s', 'p')] }, specs, 3), [])

// 분기 한쪽이 비면 주의 (양쪽 다 이으면 통과, 양쪽 다 비면 끝 블록이라 조용히), 반복의 '완료'는 비어도 괜찮음
assert.deepEqual(checkGraph({ nodes: [n('s', 'start'), n('v', 'vlm_check'), mj('a')], edges: [e('s', 'v'), e('v', 'a', 'yes')] }, specs, 3).map((i) => `${i.level}:${i.node}:${i.text}`), ["warn:v:'아니오' 쪽이 연결되지 않아 그쪽으로 가면 실행이 끝납니다"])
assert.deepEqual(checkGraph({ nodes: [n('s', 'start'), n('v', 'vlm_check'), mj('a'), mj('b')], edges: [e('s', 'v'), e('v', 'a', 'yes'), e('v', 'b', 'no')] }, specs, 3), [])
assert.deepEqual(checkGraph({ nodes: [n('s', 'start'), n('v', 'vlm_check')], edges: [e('s', 'v')] }, specs, 3), [])

console.log('check OK')
