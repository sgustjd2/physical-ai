// 계산용 로봇 (메시 없음): URDF 관절 한계 + 팔 끝 위치(순기구학). 3D 경로 미리보기와 실행 전 동작 점검(motionPlan.js)이 같이 쓴다.
import { Vector3 } from 'three'
import URDFLoader from 'urdf-loader'

// 팔 끝 = 프로파일 tcp_link, 없으면 루트에서 관절을 가장 많이 거친 끝 링크 (보통 플랜지)
function leafLink(bot) {
  let best
  let depth = -1
  for (const link of Object.values(bot.links)) {
    if (link.children.some((c) => c.isURDFJoint)) continue
    let d = 0
    for (let p = link.parent; p; p = p.parent) if (p.isURDFJoint) d += 1
    if (d > depth) { best = link; depth = d }
  }
  return best
}

// → { limits: { 관절: { lower, upper, velocity } }, tipAt(pose) → [x, y, z] (로봇 기준 m, ROS Z 위쪽), tcpMissing } | null
export function robotModel(urdf, tcpName) {
  if (!urdf) return null
  const loader = new URDFLoader()
  loader.loadMeshCb = (path, manager, material, done) => done(null) // 계산용이라 메시는 받지 않음
  const bot = loader.parse(urdf)
  const tcp = bot.links[tcpName] || leafLink(bot)
  const limits = {}
  for (const [name, j] of Object.entries(bot.joints)) {
    if (!['revolute', 'continuous', 'prismatic'].includes(j.jointType)) continue
    const open = j.jointType === 'continuous' || !(j.limit.lower < j.limit.upper)
    limits[name] = { lower: open ? -Infinity : j.limit.lower, upper: open ? Infinity : j.limit.upper, velocity: Number(j.limit.velocity) || 0 }
    j.ignoreLimits = true // 범위 밖 목표도 그대로 그린다 (범위 검사는 motionPlan.js가 따로 알림)
  }
  const v = new Vector3()
  const tipAt = (pose) => {
    for (const [n, val] of Object.entries(pose)) bot.joints[n]?.setJointValue(val)
    bot.updateMatrixWorld(true)
    tcp.getWorldPosition(v)
    return [v.x, v.y, v.z]
  }
  return { limits, tipAt, tcpMissing: tcpName && !bot.links[tcpName] ? tcpName : '' }
}
