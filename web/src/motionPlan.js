// 실행 전 경로 미리보기: 워크플로에서 팔 동작 블록의 목표 자세와 이어지는 순서를 뽑는다 (3D에 끝점 경로로 그림, motionPlan.test.js).
// 동작이 아닌 블록(대기·그리퍼·분기·반복·합류…)은 건너뛰어 다음 동작으로 잇는다 → 분기·반복·병렬은 여러 갈래 선이 된다.
// 시작 노드에서 닿지 않는 블록, 관절 값이 잘못된 블록(실행 전 점검이 따로 알림)은 빠진다.
// '녹화 동작 재생'처럼 웹이 궤적을 모르는 동작에서는 선이 끊긴다.
const UNKNOWN_MOTION = new Set(['play_episode'])

export function motionPlan({ nodes, edges }, names, homeDeg = []) {
  const ok = (vals) => Array.isArray(vals) && names.length > 0 && vals.length === names.length
    && vals.every((v) => v !== '' && v != null && Number.isFinite(Number(v)))
  const pose = (deg) => Object.fromEntries(names.map((n, i) => [n, (Number(deg[i]) * Math.PI) / 180]))
  const target = (n) => {
    if (n.type === 'move_j') return ok(n.data?.joints) ? pose(n.data.joints) : null
    if (n.type === 'move_home') return ok(homeDeg) ? pose(homeDeg) : null
    return null
  }
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const out = new Map()
  for (const e of edges) {
    if (byId.has(e.source) && byId.has(e.target)) out.set(e.source, [...(out.get(e.source) || []), e.target])
  }
  const start = nodes.find((n) => n.type === 'start')
  const reach = new Set(start ? [start.id] : [])
  const q = start ? [start.id] : []
  while (q.length) for (const t of out.get(q.shift()) || []) if (!reach.has(t)) { reach.add(t); q.push(t) }

  const waypoints = nodes.filter((n) => reach.has(n.id)).map((n) => ({ id: n.id, pose: target(n) })).filter((w) => w.pose)
  const isWaypoint = new Set(waypoints.map((w) => w.id))
  const segments = []
  for (const w of waypoints) {
    const seen = new Set([w.id])
    const stack = [...(out.get(w.id) || [])]
    while (stack.length) {
      const id = stack.pop()
      if (seen.has(id)) continue
      seen.add(id)
      if (isWaypoint.has(id)) { segments.push([w.id, id]); continue } // 다음 동작까지 한 구간
      if (UNKNOWN_MOTION.has(byId.get(id).type)) continue
      stack.push(...(out.get(id) || []))
    }
  }
  return { waypoints, segments }
}
