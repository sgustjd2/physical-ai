// 워크플로 노드 정의. 새 노드 타입 = SPECS에 한 줄 + ros/workflow_executor.py step()에 분기 하나.
import { createContext, useContext } from 'react'
import { Handle, Position, useReactFlow } from '@xyflow/react'
import { currentDeg, moveTo } from './ros'

export const JointNames = createContext([]) // 실행기가 알려준 조인트 순서

const OPS = ['==', '!=', '>', '<', '>=', '<=']

export const SPECS = {
  start: { label: '시작', defaults: {} },
  move_j: {
    label: 'MoveJ 관절 이동',
    defaults: { joints: [0, 0, 0, 0, 0, 0], duration: 2 },
    fields: [['duration', '이동 시간 (s)', 'number']],
  },
  wait: { label: '대기', defaults: { sec: 1 }, fields: [['sec', '시간 (s)', 'number']] },
  wait_topic: {
    label: '토픽 조건 대기',
    defaults: { topic: '/sensor/ready', field: 'data', op: '==', value: 'true', timeout: 0 },
    fields: [['topic', '토픽'], ['field', '필드 (예: data, pose.x)'], ['op', '조건', OPS], ['value', '값'],
      ['timeout', '타임아웃 (s, 0=무한)', 'number']],
  },
  publish: {
    label: '토픽 발행',
    defaults: { topic: '/gripper/cmd', type: 'std_msgs/msg/Bool', data: '{"data": true}' },
    fields: [['topic', '토픽'], ['type', '메시지 타입'], ['data', '내용 (JSON)', 'textarea']],
  },
}

function Joints({ id, data }) {
  const { updateNodeData } = useReactFlow()
  const names = useContext(JointNames)
  const setJ = (i) => (e) => updateNodeData(id, { joints: data.joints.map((v, j) => (j === i ? e.target.value : v)) })
  return (
    <>
      <div className="joints">
        {data.joints.map((v, i) => (
          <label key={i} title={names[i]}>J{i + 1}°
            <input className="nodrag" type="number" value={v} onChange={setJ(i)} />
          </label>
        ))}
      </div>
      <div className="row">
        <button className="nodrag" disabled={!names.length} onClick={() => updateNodeData(id, { joints: currentDeg(names) })}>
          현재 자세 저장
        </button>
        <button className="nodrag" disabled={!names.length} onClick={() => moveTo(data.joints.map(Number), Number(data.duration) || 2)}>
          이 자세로 이동
        </button>
      </div>
    </>
  )
}

function FlowNode({ id, type, data }) {
  const { updateNodeData } = useReactFlow()
  const spec = SPECS[type]
  // 입력값은 문자열 그대로 저장하고 숫자 변환은 실행기가 한다 (입력 중 '-', '' 같은 값 보존)
  const bind = (k) => ({ className: 'nodrag', value: data[k] ?? '', onChange: (e) => updateNodeData(id, { [k]: e.target.value }) })
  return (
    <div className={`node node-${type}`}>
      {type !== 'start' && <Handle type="target" position={Position.Left} />}
      <div className="node-title">{spec.label}</div>
      {type === 'move_j' && <Joints id={id} data={data} />}
      {spec.fields?.map(([k, label, kind]) => (
        <label key={k}>{label}
          {Array.isArray(kind) ? <select {...bind(k)}>{kind.map((o) => <option key={o}>{o}</option>)}</select>
            : kind === 'textarea' ? <textarea rows={2} {...bind(k)} className="nodrag nowheel" />
              : <input type={kind || 'text'} {...bind(k)} />}
        </label>
      ))}
      <Handle type="source" position={Position.Right} />
    </div>
  )
}

export const nodeTypes = Object.fromEntries(Object.keys(SPECS).map((k) => [k, FlowNode]))
