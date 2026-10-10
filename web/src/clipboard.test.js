// node src/clipboard.test.js — 블록 복사/붙여넣기 형식 확인 (CI web 작업에서 실행)
import assert from 'node:assert/strict'
import { copyText, instantiate, parseClip } from './clipboard.js'

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

console.log('clipboard OK')
