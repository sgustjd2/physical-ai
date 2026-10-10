// rosbridge 연결 하나를 앱 전체가 공유한다. 웹은 특정 로봇을 모른다: 로봇 정보는 전부 ROS 토픽으로 받는다.
// 주소 기본값: 웹을 연 호스트의 :9090. 다른 PC의 브리지에 붙으려면 ?ros=ws://IP:9090
import { Ros, Topic } from 'roslib'

export const url = new URLSearchParams(location.search).get('ros') || `ws://${location.hostname}:9090`
export const ros = new Ros()

// 30Hz로 오는 값은 React state로 두지 않고 여기 두고, 필요한 쪽(3D 렌더 루프 등)이 읽어간다
// joints: { 조인트이름: rad }, count/stamp: 수신 상태 표시용, command: 마지막 이동 명령의 목표 { 조인트이름: rad }
// simJoints: 디지털 트윈 팔(/sim) 자세 (시뮬레이션 실행 때 3D에 그림)
export const latest = { joints: {}, simJoints: {}, count: 0, stamp: 0, command: null }

const connect = () => ros.connect(url).catch(() => {})
ros.on('close', () => setTimeout(connect, 2000))
connect()

const topic = (name, messageType, opts) => new Topic({ ros, name, messageType, ...opts })
const json = (name) => topic(name, 'std_msgs/msg/String')

topic('/joint_states', 'sensor_msgs/msg/JointState', { throttle_rate: 33 }).subscribe((m) => {
  m.name.forEach((n, i) => { latest.joints[n] = m.position[i] })
  latest.count += 1
  latest.stamp = performance.now()
})

topic('/sim/joint_states', 'sensor_msgs/msg/JointState', { throttle_rate: 33 }).subscribe((m) => {
  m.name.forEach((n, i) => { latest.simJoints[n] = m.position[i] })
})

// 실행기가 팔에 보낸 이동 명령 (디지털 트윈에서 '명령 목표 vs 실제 자세' 표시용)
topic('/workflow/command', 'trajectory_msgs/msg/JointTrajectory').subscribe((m) => {
  const p = m.points[m.points.length - 1]
  latest.command = p ? Object.fromEntries(m.joint_names.map((n, i) => [n, p.positions[i]])) : null
})

// 아래 상태 토픽은 모두 latched(transient_local)라 접속하자마자 현재 값이 온다
export const statusTopic = json('/workflow/status') // 실행 상태 + 관절 이름
export const nodeTypesTopic = json('/workflow/node_types') // 노드 타입과 입력 필드 선언 (ros/nodes/*.py)
export const episodeTopic = json('/episode/status') // 녹화 상태 + 최근 에피소드
export const robotDescription = json('/robot_description') // URDF (robots/<로봇>/ 또는 제조사 드라이버)
export const libraryTopic = json('/workflow/library') // GB10에 저장된 워크플로 목록 (ros/workflow_store.py)
export const logTopic = json('/workflow/log') // 실행 기록: 시작·종료·AI 판단 근거
export const generateTopic = json('/workflow/generate') // AI 시나리오 생성 결과 (ros/scenario_ai.py)

const runTopic = json('/workflow/run')
const stopTopic = topic('/workflow/stop', 'std_msgs/msg/Empty')
const episodeCmd = json('/episode/cmd')
const libraryCmd = json('/workflow/library/cmd')
const generateCmd = json('/workflow/generate/cmd')
// 미리 advertise 해둔다: 처음 만든 퍼블리셔로 바로 보내면 디스커버리 전에 메시지가 사라질 수 있음
for (const t of [runTopic, stopTopic, episodeCmd, libraryCmd, generateCmd]) t.advertise()

// mode: 'real' = 실제 로봇, 'sim' = 디지털 트윈에서만 (실제 팔·장비는 그대로)
export const runWorkflow = (graph, mode = 'real') => runTopic.publish({ data: JSON.stringify({ ...graph, mode }) })
export const stopWorkflow = () => stopTopic.publish({})
// crypto.randomUUID는 http(비보안) 접속에선 없으므로 Math.random
const cmdId = () => Math.random().toString(36).slice(2, 10)
export const sendEpisode = (op, extra = {}) => episodeCmd.publish({ data: JSON.stringify({ op, id: cmdId(), ...extra }) })
export const sendGenerate = (prompt) => {
  const id = cmdId()
  generateCmd.publish({ data: JSON.stringify({ id, prompt }) })
  return id
}
export const sendLibrary = (op, extra = {}) => {
  const id = cmdId()
  libraryCmd.publish({ data: JSON.stringify({ op, id, ...extra }) })
  return id
}

// 실행기 조인트 순서대로 현재 각도(deg)
export const currentDeg = (names) => names.map((n) => +((latest.joints[n] ?? 0) * 180 / Math.PI).toFixed(1))

// 단일 MoveJ 워크플로 = 조그
export const moveTo = (deg, duration = 0.5) => runWorkflow({
  nodes: [{ id: 'start', type: 'start' }, { id: 'jog', type: 'move_j', data: { joints: deg, duration } }],
  edges: [{ source: 'start', target: 'jog' }],
})

export { topic }
