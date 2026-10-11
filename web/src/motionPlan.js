// 실행 전 경로 미리보기: 워크플로에서 팔 동작 블록의 목표 자세와 이어지는 순서를 뽑는다 (3D에 끝점 경로로 그림, motionPlan.test.js).
// 동작이 아닌 블록(대기·그리퍼·분기·반복·합류…)은 건너뛰어 다음 동작으로 잇는다 → 분기·반복·병렬은 여러 갈래 선이 된다.
// 시작 노드에서 닿지 않는 블록, 관절 값이 잘못된 블록(실행 전 점검이 따로 알림)은 빠진다.
// '녹화 동작 재생'처럼 웹이 궤적을 모르는 동작에서는 선이 끊긴다.
const UNKNOWN_MOTION = new Set(['play_episode'])
const DURATION = { move_j: 2, move_home: 3 } // 이동 시간 기본값 (ros/nodes/motion.py와 같게)

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

  const waypoints = nodes.filter((n) => reach.has(n.id))
    .map((n) => ({ id: n.id, pose: target(n), duration: Number(n.data?.duration) || DURATION[n.type] }))
    .filter((w) => w.pose)
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

// 실행 전 동작 점검: motionPlan 결과를 로봇 한계·작업 셀과 비교 → [{ level, node, text }] (check.js와 같은 모양)
//   error  관절 범위 밖, 속도 한계 초과 (실행기도 팔에 보내기 전에 같은 규칙으로 멈춤: ros/nodes/motion.py)
//   warn   팔 끝(TCP)이 작업 셀 물체 안을 지나감
// limits: { 관절: { lower, upper, velocity } } (rad, rad/s; 없으면 검사 안 함)
// cell: { tipAt(pose) → [x, y, z] 로봇 기준 m, obstacles: 작업 셀 물체 (robot.yaml scene) } | null
// ponytail: 팔 끝 한 점만 본다 (링크 몸통·그리퍼 부피는 MoveIt2 충돌 검사의 일). 메시 물체는 모양을 몰라 건너뜀
export const PEAK = 1.5 // 정지→정지 이동의 최고 속도 / 평균 속도 (부드러운 3차 보간, 트윈 팔과 같음)
const STEP = 0.02 // rad: 구간을 이 관절 간격으로 잘라 팔 끝 위치를 본다 (팔 길이 1m면 약 2cm)

export function checkMotion(plan, limits = {}, cell = null) {
  const issues = []
  const byId = new Map(plan.waypoints.map((w) => [w.id, w]))
  const deg = (r) => Math.round((r * 180) / Math.PI)
  for (const w of plan.waypoints) {
    const bad = Object.entries(w.pose).find(([j, v]) => limits[j] && (v < limits[j].lower - 1e-6 || v > limits[j].upper + 1e-6))
    if (bad) issues.push({ level: 'error', node: w.id, text: `${bad[0]} ${deg(bad[1])}°: 범위(${deg(limits[bad[0]].lower)}~${deg(limits[bad[0]].upper)}°) 밖입니다` })
  }
  const need = new Map() // 구간 끝 블록 → 속도 한계 안에 들어오는 최소 이동 시간 (들어오는 구간 중 가장 긴 것)
  for (const [a, b] of plan.segments) {
    const A = byId.get(a).pose
    const B = byId.get(b)
    for (const [j, v] of Object.entries(B.pose)) {
      const vel = limits[j]?.velocity
      const t = vel > 0 && j in A ? (PEAK * Math.abs(v - A[j])) / vel : 0
      if (t > B.duration + 1e-9 && t > (need.get(b)?.t ?? 0)) need.set(b, { t, j })
    }
  }
  for (const [id, { t, j }] of need) issues.push({ level: 'error', node: id, text: `너무 빠릅니다(${j}). 이동 시간을 ${Math.ceil(t * 10) / 10}초 이상으로 하세요` })

  const solids = (cell?.tipAt && cell.obstacles || []).filter((o) => o.obstacle !== false).map(solid).filter(Boolean)
  if (solids.length) {
    const hit = (pose) => { const p = cell.tipAt(pose); return solids.find((o) => o.inside(p)) }
    const warned = new Set()
    const warn = (id, text) => { if (!warned.has(id)) { warned.add(id); issues.push({ level: 'warn', node: id, text }) } }
    for (const w of plan.waypoints) { const o = hit(w.pose); if (o) warn(w.id, `목표 자세에서 팔 끝이 ${o.name}에 닿습니다`) }
    for (const [a, b] of plan.segments) { // MoveJ는 관절 공간 보간 → 팔 끝은 곡선으로 지나감
      const A = byId.get(a).pose
      const B = byId.get(b).pose
      const n = Math.max(8, Math.ceil(Math.max(...Object.keys(A).map((k) => Math.abs((B[k] ?? A[k]) - A[k]))) / STEP))
      for (let i = 1; i < n; i++) {
        const o = hit(Object.fromEntries(Object.keys(A).map((k) => [k, A[k] + ((B[k] ?? A[k]) - A[k]) * (i / n)])))
        if (o) { warn(b, `가는 길에 팔 끝이 ${o.name}에 닿습니다`); break }
      }
    }
  }
  return issues
}

// 작업 셀 물체(robot.yaml scene, 로봇 기준 m·라디안, rpy는 ROS 'ZYX') → { name, inside([x, y, z]) }. 원기둥 축은 z
const rot = ([x, y, z], axis, a) => {
  const c = Math.cos(a)
  const s = Math.sin(a)
  return axis === 'x' ? [x, c * y - s * z, s * y + c * z] : axis === 'y' ? [c * x + s * z, y, c * z - s * x] : [c * x - s * y, s * x + c * y, z]
}
function solid(o) {
  const [ox, oy, oz] = o.xyz || [0, 0, 0]
  const [r, p, y] = o.rpy || [0, 0, 0]
  const local = (q) => rot(rot(rot([q[0] - ox, q[1] - oy, q[2] - oz], 'z', -y), 'y', -p), 'x', -r) // 물체 좌표로
  const name = o.name || o.shape
  if (o.shape === 'box' && o.size) return { name, inside: (q) => local(q).every((v, i) => Math.abs(v) < o.size[i] / 2) }
  if (o.shape === 'cylinder') return { name, inside: (q) => { const [x, y2, z] = local(q); return x * x + y2 * y2 < o.radius ** 2 && Math.abs(z) < o.height / 2 } }
  if (o.shape === 'sphere') return { name, inside: (q) => Math.hypot(...local(q)) < o.radius }
  return null
}
