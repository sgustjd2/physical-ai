// 블록 복사/붙여넣기. 선택한 블록과 그 사이 연결을 JSON 글자로 주고받는다 → 다른 탭·다른 워크플로에도 붙여넣기 가능.
// 붙여넣는 글자는 어디서 왔는지 모르므로(메모장에서 고친 것 등) 형식을 검사하고, 붙일 때 새 id를 단다.
const FORMAT = 'physical-ai/blocks'
const MAX = 200 // 한 번에 붙여넣는 블록 수 상한

export function copyText(nodes, edges) {
  const picked = nodes.filter((n) => n.selected && n.type !== 'start')
  if (!picked.length) return null
  const ids = new Set(picked.map((n) => n.id))
  return JSON.stringify({
    format: FORMAT,
    nodes: picked.map(({ id, type, data, position }) => ({ id, type, data, position })),
    edges: edges.filter((e) => ids.has(e.source) && ids.has(e.target))
      .map(({ source, target, sourceHandle }) => ({ source, target, ...(sourceHandle ? { sourceHandle } : {}) })),
  })
}

// 형식이 맞으면 { nodes, edges }, 아니면 null (다른 글자를 붙여넣은 경우)
export function parseClip(text) {
  let v
  try { v = JSON.parse(text) } catch { return null }
  if (v?.format !== FORMAT || !Array.isArray(v.nodes) || !Array.isArray(v.edges)) return null
  const nodes = v.nodes.slice(0, MAX).filter((n) => typeof n?.id === 'string' && typeof n.type === 'string' && n.type !== 'start'
    && n.data && typeof n.data === 'object' && !Array.isArray(n.data)
    && Number.isFinite(n.position?.x) && Number.isFinite(n.position?.y))
  if (!nodes.length) return null
  const ids = new Set(nodes.map((n) => n.id))
  const edges = v.edges.filter((e) => ids.has(e?.source) && ids.has(e?.target)
    && (e.sourceHandle == null || typeof e.sourceHandle === 'string'))
  return { nodes, edges }
}

// 새 id를 달고 (dx, dy)만큼 옮긴 사본. 붙여넣은 블록만 선택된 상태로
export function instantiate(clip, makeId, dx, dy) {
  const id = new Map(clip.nodes.map((n) => [n.id, makeId()]))
  return {
    nodes: clip.nodes.map((n) => ({
      id: id.get(n.id), type: n.type, data: structuredClone(n.data), position: { x: n.position.x + dx, y: n.position.y + dy }, selected: true,
    })),
    edges: clip.edges.map((e) => {
      const source = id.get(e.source)
      const target = id.get(e.target)
      return { id: `${source}-${e.sourceHandle || 'out'}-${target}`, source, target, ...(e.sourceHandle ? { sourceHandle: e.sourceHandle } : {}) }
    }),
  }
}
