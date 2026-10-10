// rosbridge 연결 하나를 앱 전체가 공유한다. 웹은 특정 로봇을 모른다: 로봇 정보는 전부 ROS 토픽으로 받는다.
// 주소 기본값: 웹을 연 호스트의 :9090. 다른 PC의 브리지에 붙으려면 ?ros=ws://IP:9090
import { Ros, Topic } from 'roslib'

export const url = new URLSearchParams(location.search).get('ros') || `ws://${location.hostname}:9090`
export const ros = new Ros()

// 30Hz로 오는 값은 React state로 두지 않고 여기 두고, 필요한 쪽(3D 렌더 루프 등)이 읽어간다
export const latest = { joints: {}, count: 0, stamp: 0 } // joints: { 조인트이름: rad }, count/stamp: 수신 상태 표시용

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

// 아래 상태 토픽은 모두 latched(transient_local)라 접속하자마자 현재 값이 온다
export const statusTopic = json('/workflow/status') // 실행 상태 + 관절 이름
export const nodeTypesTopic = json('/workflow/node_types') // 노드 타입과 입력 필드 선언 (ros/nodes/*.py)
export const episodeTopic = json('/episode/status') // 녹화 상태 + 최근 에피소드
export const robotDescription = json('/robot_description') // URDF (robots/<로봇>/ 또는 제조사 드라이버)

const runTopic = json('/workflow/run')
const stopTopic = topic('/workflow/stop', 'std_msgs/msg/Empty')
const episodeCmd = json('/episode/cmd')
// 미리 advertise 해둔다: 처음 만든 퍼블리셔로 바로 보내면 디스커버리 전에 메시지가 사라질 수 있음
for (const t of [runTopic, stopTopic, episodeCmd]) t.advertise()

export const runWorkflow = (graph) => runTopic.publish({ data: JSON.stringify(graph) })
export const stopWorkflow = () => stopTopic.publish({})
// crypto.randomUUID는 http(비보안) 접속에선 없으므로 Math.random
export const sendEpisode = (op, extra = {}) =>
  episodeCmd.publish({ data: JSON.stringify({ op, id: Math.random().toString(36).slice(2, 10), ...extra }) })

// 실행기 조인트 순서대로 현재 각도(deg)
export const currentDeg = (names) => names.map((n) => +((latest.joints[n] ?? 0) * 180 / Math.PI).toFixed(1))

// 단일 MoveJ 워크플로 = 조그
export const moveTo = (deg, duration = 0.5) => runWorkflow({
  nodes: [{ id: 'start', type: 'start' }, { id: 'jog', type: 'move_j', data: { joints: deg, duration } }],
  edges: [{ source: 'start', target: 'jog' }],
})

export { topic }
