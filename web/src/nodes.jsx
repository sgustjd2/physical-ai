// 워크플로 노드 UI. 노드 타입과 입력 필드는 실행기(ros/nodes/*.py)가 /workflow/node_types 로 알려주고
// 여기서는 그것을 그리기만 한다. 새 노드 타입을 추가해도 이 파일은 고치지 않는다.
import { createContext, useContext } from 'react'
import { Handle, Position, useReactFlow } from '@xyflow/react'
import { currentDeg, moveTo } from './ros'

export const Specs = createContext({}) // type -> {type, label, fields}
export const JointNames = createContext([]) // 로봇 프로파일의 관절 순서

const START = { type: 'start', label: '시작', fields: [] }

export const defaults = (spec, names) =>
  Object.fromEntries(spec.fields.map((f) => [f.key, f.kind === 'joints' ? names.map(() => 0) : f.default]))

function Joints({ id, data, value }) {
  const { updateNodeData } = useReactFlow()
  const names = useContext(JointNames)
  const vals = Array.from({ length: names.length || value?.length || 0 }, (_, i) => value?.[i] ?? 0)
  const set = (i) => (e) => updateNodeData(id, { joints: vals.map((v, j) => (j === i ? e.target.value : v)) })
  return (
    <>
      <div className="joints">
        {vals.map((v, i) => (
          <label key={i} title={names[i]}>J{i + 1}
            <input className="nodrag" type="number" value={v} onChange={set(i)} />
          </label>
        ))}
      </div>
      <div className="row">
        <button className="nodrag" disabled={!names.length} onClick={() => updateNodeData(id, { joints: currentDeg(names) })}>
          현재 자세 저장
        </button>
        <button className="nodrag" disabled={!names.length} onClick={() => moveTo(vals.map(Number), Number(data.duration) || 2)}>
          이 자세로 이동
        </button>
      </div>
    </>
  )
}

function Field({ id, data, f }) {
  const { updateNodeData } = useReactFlow()
  if (f.kind === 'joints') return <Joints id={id} data={data} value={data[f.key]} />
  // 입력값은 문자열 그대로 저장하고 숫자 변환은 실행기가 한다 (입력 중 '-', '' 같은 값 보존)
  const p = { className: 'nodrag', value: data[f.key] ?? '', onChange: (e) => updateNodeData(id, { [f.key]: e.target.value }) }
  if (f.kind === 'select') return <select {...p}>{f.options.map((o) => <option key={o}>{o}</option>)}</select>
  if (f.kind === 'json') return <textarea rows={2} {...p} className="nodrag nowheel" />
  return <input type={f.kind === 'number' ? 'number' : 'text'} {...p} />
}

export function FlowNode({ id, type, data }) {
  const specs = useContext(Specs)
  const spec = type === 'start' ? START : specs[type]
  return (
    <div className={`node node-${type}${spec ? '' : ' unknown'}`}>
      {type !== 'start' && <Handle type="target" position={Position.Left} />}
      <div className="node-title">{spec?.label ?? type}</div>
      {!spec && <p className="muted">이 서버에 없는 노드 타입 (실행기 연결 전이거나 플러그인 없음)</p>}
      {spec?.fields.map((f) => (
        <label key={f.key}>{f.label}<Field id={id} data={data} f={f} /></label>
      ))}
      <Handle type="source" position={Position.Right} />
    </div>
  )
}
