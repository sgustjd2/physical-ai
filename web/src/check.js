// 실행 전 점검: 실행하다 멈출 문제를 편집하는 동안 미리 찾는다 (React와 무관 → check.test.js로 확인).
// 반환: [{ level: 'error' | 'warn', node, text }]. error가 있으면 실행·시뮬레이션을 막는다.
//   error  같은 장비(resource)를 동시에 쓰는 병렬 갈래, 관절 값·숫자 칸 오류, 고르지 않은 데이터셋, 서버에 없는 블록(실행 경로 안)
//   warn   시작과 이어지지 않아 실행되지 않는 블록, 분기(예/아니오)의 한쪽이 비어 그쪽으로 가면 실행이 끝나는 블록
// specs: type → 블록 선언 (빈 객체면 아직 못 받은 것 → 타입·칸 검사는 건너뜀), jointCount: 0이면 관절 수 검사 건너뜀
const RESOURCE = { arm: '로봇팔을', gripper: '그리퍼를' } // 장비 이름 + 조사
const isNum = (v) => v !== '' && v != null && Number.isFinite(Number(v))
// 목적격 조사: 마지막 글자에 받침이 있으면 '을', 없으면 '를'
const eul = (w) => { const c = w.charCodeAt(w.length - 1); return c >= 0xac00 && c <= 0xd7a3 && (c - 0xac00) % 28 ? '을' : '를' }

export function checkGraph({ nodes, edges }, specs, jointCount = 0) {
  const issues = []
  const loaded = Object.keys(specs).length > 0
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const firstPort = (type) => specs[type]?.outputs?.[0]?.id || 'out'
  const out = new Map() // node → [target] (모든 포트)
  const forks = new Map() // "node|port" → [target]
  for (const e of edges) {
    if (!byId.has(e.source) || !byId.has(e.target)) continue
    out.set(e.source, [...(out.get(e.source) || []), e.target])
    const key = `${e.source}|${e.sourceHandle || firstPort(byId.get(e.source).type)}`
    forks.set(key, [...(forks.get(key) || []), e.target])
  }

  // 시작에서 닿는 블록
  const start = nodes.find((n) => n.type === 'start')
  const reach = new Set(start ? [start.id] : [])
  const q = start ? [start.id] : []
  while (q.length) for (const t of out.get(q.shift()) || []) if (!reach.has(t)) { reach.add(t); q.push(t) }

  for (const n of nodes) {
    if (n.type === 'start') continue
    if (!reach.has(n.id)) { issues.push({ level: 'warn', node: n.id, text: '시작과 이어지지 않아 실행되지 않습니다' }); continue }
    if (!loaded) continue
    const spec = specs[n.type]
    // 분기: 예/아니오처럼 갈래가 둘 이상인데 한쪽이 비어 있으면 그쪽으로 갔을 때 조용히 끝남 (반복의 '완료'는 끝내는 게 흔해 제외)
    const outs = spec?.outputs || []
    const empty = outs.length > 1 && n.type !== 'loop' ? outs.filter((o) => !(forks.get(`${n.id}|${o.id}`) || []).length) : []
    if (empty.length && empty.length < outs.length) issues.push({ level: 'warn', node: n.id, text: `'${empty.map((o) => o.label || o.id).join(', ')}' 쪽이 연결되지 않아 그쪽으로 가면 실행이 끝납니다` })
    if (!spec) { issues.push({ level: 'error', node: n.id, text: `이 서버에 없는 블록(${n.type})이라 실행할 수 없습니다` }); continue }
    for (const f of spec.fields) {
      const v = n.data?.[f.key]
      if (f.kind === 'number' && !isNum(v)) issues.push({ level: 'error', node: n.id, text: `'${f.label}'에 숫자를 넣으세요` })
      if (f.kind === 'dataset' && !v) issues.push({ level: 'error', node: n.id, text: `'${f.label}'${eul(f.label)} 고르세요` })
      if (f.kind === 'joints') {
        const vals = Array.isArray(v) ? v : []
        if (vals.some((x) => !isNum(x))) issues.push({ level: 'error', node: n.id, text: '비어 있거나 숫자가 아닌 관절 값이 있습니다' })
        else if (jointCount && vals.length !== jointCount) issues.push({ level: 'error', node: n.id, text: `관절 값이 ${vals.length}개입니다 (로봇 관절 ${jointCount}개)` })
      }
    }
  }

  // 병렬 갈래끼리 같은 장비: 갈래마다 합류 노드 전까지 닿는 블록을 모아 비교
  if (loaded) {
    const flagged = new Set()
    for (const targets of forks.values()) {
      if (targets.length < 2) continue
      const branches = targets.map((t) => {
        const seen = new Set()
        const stack = [t]
        while (stack.length) {
          const id = stack.pop()
          if (seen.has(id) || byId.get(id)?.type === 'join') continue
          seen.add(id)
          stack.push(...(out.get(id) || []))
        }
        return [...seen].filter((id) => specs[byId.get(id).type]?.resource)
      })
      for (let i = 0; i < branches.length; i++) {
        for (let j = i + 1; j < branches.length; j++) {
          for (const a of branches[i]) {
            for (const b of branches[j]) {
              const res = specs[byId.get(a).type].resource
              if (a === b || res !== specs[byId.get(b).type].resource) continue
              for (const id of [a, b]) {
                if (flagged.has(id)) continue
                flagged.add(id)
                issues.push({ level: 'error', node: id, text: `동시에 실행되는 다른 갈래도 ${RESOURCE[res] || `${res}을(를)`} 씁니다. 합류 블록 뒤로 옮기거나 한 갈래로 이으세요` })
              }
            }
          }
        }
      }
    }
  }
  return issues
}
