// rosbridge 연결 하나를 앱 전체가 공유한다.
// 주소 기본값: 웹을 연 호스트의 :9090. 다른 PC의 브리지에 붙으려면 ?ros=ws://IP:9090
import { Ros, Topic } from 'roslib'

export const url = new URLSearchParams(location.search).get('ros') || `ws://${location.hostname}:9090`
export const ros = new Ros()

// 30Hz로 오는 값은 React state로 두지 않고 여기 두고, 필요한 쪽(3D 렌더 루프 등)이 읽어간다
export const latest = { joints: {} } // { 조인트이름: rad }

const connect = () => ros.connect(url).catch(() => {})
ros.on('close', () => setTimeout(connect, 2000))
connect()

const topic = (name, messageType, opts) => new Topic({ ros, name, messageType, ...opts })

topic('/joint_states', 'sensor_msgs/msg/JointState', { throttle_rate: 33 }).subscribe((m) => {
  m.name.forEach((n, i) => { latest.joints[n] = m.position[i] })
})

export const statusTopic = topic('/workflow/status', 'std_msgs/msg/String')
const runTopic = topic('/workflow/run', 'std_msgs/msg/String')
const stopTopic = topic('/workflow/stop', 'std_msgs/msg/Empty')
// 미리 advertise 해둔다: 처음 만든 퍼블리셔로 바로 보내면 디스커버리 전에 메시지가 사라질 수 있음
runTopic.advertise()
stopTopic.advertise()

export const runWorkflow = (graph) => runTopic.publish({ data: JSON.stringify(graph) })
export const stopWorkflow = () => stopTopic.publish({})

// 실행기 조인트 순서대로 현재 각도(deg)
export const currentDeg = (names) => names.map((n) => +((latest.joints[n] ?? 0) * 180 / Math.PI).toFixed(1))

// 단일 MoveJ 워크플로 = 조그
export const moveTo = (deg, duration = 0.5) => runWorkflow({
  nodes: [{ id: 'start', type: 'start' }, { id: 'jog', type: 'move_j', data: { joints: deg, duration } }],
  edges: [{ source: 'start', target: 'jog' }],
})

export { topic }
