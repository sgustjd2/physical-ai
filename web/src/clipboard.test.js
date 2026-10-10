// node src/clipboard.test.js — 블록 복사/붙여넣기 형식 확인 (CI web 작업에서 실행)
import assert from 'node:assert/strict'
import { copyText, instantiate, parseClip, restoreLinks } from './clipboard.js'

const nodes = [
  { id: 'n0', type: 'start', data: {}, position: { x: 0, y: 0 }, selected: true }, // 시작 노드는 복사하지 않음
  { id: 'a', type: 'move_j', data: { joints: [1, 2] }, position: { x: 10, y: 80 }, selected: true, measured: { width: 220 } },
  { id: 'b', type: 'if', data: {}, position: { x: 10, y: 180 }, selected: true },
  { id: 'c', type: 'wait', data: { sec: 1 }, position: { x: 10, y: 280 } }, // 선택 안 됨
]
const edges = [
  { id: 'e1', source: 'n0', target: 'a' }, // 선택 밖과 이어진 연결은 빠짐
  { id: 'e2', source: 'a', target: 'b' },
  { id: 'e3', source: 'b', target: 'c', sourceHandle: 'yes' },
  { id: 'e4', source: 'b', target: 'a', sourceHandle: 'no' },
]

assert.equal(copyText(nodes.map((n) => ({ ...n, selected: false })), edges), null)
const text = copyText(nodes, edges)
const clip = parseClip(text)
assert.deepEqual(clip.nodes.map((n) => n.id), ['a', 'b'])
assert.equal(clip.nodes[0].measured, undefined)
assert.deepEqual(clip.edges, [{ source: 'a', target: 'b' }, { source: 'b', target: 'a', sourceHandle: 'no' }])

let i = 0
const out = instantiate(clip, () => `p${i++}`, 40, 40)
assert.deepEqual(out.nodes.map((n) => [n.id, n.position.x, n.position.y, n.selected]), [['p0', 50, 120, true], ['p1', 50, 220, true]])
assert.deepEqual(out.edges, [{ id: 'p0-out-p1', source: 'p0', target: 'p1' }, { id: 'p1-no-p0', source: 'p1', target: 'p0', sourceHandle: 'no' }])
out.nodes[0].data.joints[0] = 99 // 사본을 고쳐도 원본은 그대로
assert.equal(clip.nodes[0].data.joints[0], 1)

// 다른 글자·깨진 형식은 무시
assert.equal(parseClip('그냥 글자'), null)
assert.equal(parseClip('{"format":"other","nodes":[],"edges":[]}'), null)
assert.equal(parseClip(JSON.stringify({ format: 'physical-ai/blocks', nodes: [{ id: 'x', type: 'start', data: {}, position: { x: 0, y: 0 } }], edges: [] })), null)
const bad = parseClip(JSON.stringify({
  format: 'physical-ai/blocks',
  nodes: [{ id: 'x', type: 'wait', data: {}, position: { x: 0, y: 0 } }, { id: 'y', type: 'wait', data: 'x', position: { x: 0, y: 0 } }, { id: 'z', type: 7 }],
  edges: [{ source: 'x', target: 'gone' }, { source: 'x', target: 'x', sourceHandle: 3 }],
}))
assert.deepEqual(bad, { nodes: [{ id: 'x', type: 'wait', data: {}, position: { x: 0, y: 0 } }], edges: [] })

// 잘라낸 블록 되돌리기: A→B→C 에서 B를 자르면 A→C가 생긴다 → 붙여넣으면 A→B, B→C 복원 + A→C 제거
const links = {
  external: [{ source: 'A', target: 'B' }, { source: 'B', target: 'C', sourceHandle: 'yes' }, { source: 'B', target: 'D' }],
  bridges: ['A-out-C'],
}
const now = [{ id: 'A-out-C', source: 'A', target: 'C' }, { id: 'C-out-E', source: 'C', target: 'E' }]
const exists = (x) => ['A', 'C', 'E'].includes(x) // D는 그새 지워짐
const back = restoreLinks(now, links, new Map([['B', 'B']]), exists)
assert.deepEqual(back.edges.map((e) => e.id), ['C-out-E', 'A-out-B', 'B-yes-C'])
assert.equal(back.restored, 2)
assert.deepEqual(back.skipped, [{ source: 'B', target: 'D' }]) // D가 지워져 잇지 못함 → 알림에 씀
assert.equal(back.edges.find((e) => e.id === 'B-yes-C').sourceHandle, 'yes')
// 이미 같은 연결이 있으면 중복으로 만들지 않음 (복원된 것으로 셈)
const dup = restoreLinks([{ id: 'x', source: 'A', target: 'B2' }], links, new Map([['B', 'B2']]), exists)
assert.equal(dup.edges.filter((e) => e.source === 'A' && e.target === 'B2').length, 1)
assert.equal(dup.restored, 2)

console.log('clipboard OK')
