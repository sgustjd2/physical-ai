// 워크플로 노드 UI. 노드 타입·분류·입력 필드는 실행기(ros/nodes/*.py)가 /workflow/node_types 로 알려주고
// 여기서는 그리기만 한다. 새 노드 타입을 추가해도 이 파일은 고치지 않는다.
// 캔버스의 노드는 요약만 보여 주고(어떤 배율에서도 읽히도록), 편집은 선택했을 때 뜨는 인스펙터에서 실제 크기로 한다.
import { createContext, useContext } from 'react'
import { Handle, Position, useReactFlow } from '@xyflow/react'
import { Icon } from './icons'
import { currentDeg, moveTo } from './ros'

// { specs: type→spec, colorOf: type→CSS 색 } — 분류(group)마다 색 하나
export const Specs = createContext({ specs: {}, colorOf: () => 'var(--muted)' })
export const JointNames = createContext([]) // 로봇 프로파일의 관절 순서

export const START = { type: 'start', label: '시작', group: '', fields: [] }
export const CATEGORY_COLORS = 6

export const defaults = (spec, names) =>
  Object.fromEntries(spec.fields.map((f) => [f.key, f.kind === 'joints' ? names.map(() => 0) : f.default]))

// '이동 시간 (s)' → ['이동 시간', 's'] : 요약 줄에서 짧은 이름과 단위로 쓴다
const splitLabel = (label) => {
  const m = label.match(/^(.*?)\s*\((.*)\)$/)
  return m ? [m[1], m[2].length <= 2 ? m[2] : ''] : [label, '']
}

const summary = (f, v) => {
  if (f.kind === 'joints') return (v || []).map((x) => (x === '' ? '–' : +x)).join(', ') + '°'
  const [name, unit] = splitLabel(f.label)
  const text = f.kind === 'json' ? String(v ?? '').replace(/\s+/g, ' ') : v
  return `${name} ${text === '' || text == null ? '–' : text}${unit && text !== '' ? ` ${unit}` : ''}`
}

export function FlowNode({ type, data }) {
  const { specs, colorOf } = useContext(Specs)
  const spec = type === 'start' ? START : specs[type]
  return (
    <div className={`node${type === 'start' ? ' node-start' : ''}${spec ? '' : ' unknown'}`} style={{ '--cat': colorOf(type) }}>
      {type !== 'start' && <Handle type="target" position={Position.Top} />}
      <div className="node-head">
        {type === 'start' ? <Icon name="play" size={12} /> : <span className="node-dot" aria-hidden="true" />}
        <span className="node-title">{spec?.label ?? type}</span>
      </div>
      {!spec && type !== 'start' && <div className="node-sum warn-text">이 서버에 없는 노드 타입</div>}
      {spec?.fields.slice(0, 3).map((f) => <div key={f.key} className="node-sum">{summary(f, data[f.key])}</div>)}
      <Handle type="source" position={Position.Bottom} />
    </div>
  )
}

function Joints({ id, value, duration }) {
  const { updateNodeData } = useReactFlow()
  const names = useContext(JointNames)
  const vals = Array.from({ length: names.length || value?.length || 0 }, (_, i) => value?.[i] ?? 0)
  const set = (i) => (e) => updateNodeData(id, { joints: vals.map((v, j) => (j === i ? e.target.value : v)) })
  return (
    <fieldset className="field">
      <legend>관절 각도 (°)</legend>
      <div className="joints">
        {vals.map((v, i) => (
          <label key={i}>
            <span className="joint-name" title={names[i]} translate="no">{names[i] ?? `J${i + 1}`}</span>
            <input type="number" inputMode="decimal" step="1" name={`joint${i + 1}`} autoComplete="off" value={v} onChange={set(i)} />
          </label>
        ))}
      </div>
      <div className="row">
        <button disabled={!names.length} onClick={() => updateNodeData(id, { joints: currentDeg(names) })}
          title="지금 로봇 자세를 이 노드에 저장 (조그로 맞춘 뒤 누르기)">
          현재 자세 저장
        </button>
        <button disabled={!names.length} onClick={() => moveTo(vals.map(Number), Number(duration) || 2)}
          title="이 노드의 자세로 로봇을 움직여 확인">
          이 자세로 이동
        </button>
      </div>
    </fieldset>
  )
}

function Field({ id, data, f }) {
  const { updateNodeData } = useReactFlow()
  if (f.kind === 'joints') return <Joints id={id} value={data[f.key]} duration={data.duration} />
  // 입력값은 문자열 그대로 저장하고 숫자 변환은 실행기가 한다 (입력 중 '-', '' 같은 값 보존)
  const p = { name: f.key, autoComplete: 'off', value: data[f.key] ?? '', onChange: (e) => updateNodeData(id, { [f.key]: e.target.value }) }
  return (
    <label className="field">
      <span className="field-label">{f.label}</span>
      {f.kind === 'select' ? <select {...p}>{f.options.map((o) => <option key={o}>{o}</option>)}</select>
        : f.kind === 'json' ? <textarea rows={3} spellCheck={false} className="code" {...p} />
          : <input type={f.kind === 'number' ? 'number' : 'text'} inputMode={f.kind === 'number' ? 'decimal' : undefined}
            spellCheck={false} {...p} />}
    </label>
  )
}

export function Inspector({ node, onClose, onDelete, next, nextOptions, onNext }) {
  const { specs, colorOf } = useContext(Specs)
  const spec = node.type === 'start' ? START : specs[node.type]
  return (
    <section className="inspector" aria-label={`${spec?.label ?? node.type} 설정`} style={{ '--cat': colorOf(node.type) }}>
      <div className="inspector-head">
        <span className="node-dot" aria-hidden="true" />
        <h2>{spec?.label ?? node.type}</h2>
        {spec?.group && <span className="muted">{spec.group}</span>}
        <button className="icon-btn" onClick={onClose} aria-label="편집 닫기"><Icon name="close" /></button>
      </div>
      <div className="inspector-body">
        {!spec && <p className="warn-text">이 서버에 없는 노드 타입입니다. 실행기에 해당 플러그인(ros/nodes)이 있는지 확인하세요.</p>}
        {spec && !spec.fields.length && <p className="muted">설정할 항목이 없습니다. 워크플로는 여기서 시작합니다.</p>}
        {spec?.fields.map((f) => <Field key={f.key} id={node.id} data={node.data} f={f} />)}
        <label className="field">
          <span className="field-label">다음 단계</span>
          <select name="next" value={next} onChange={(e) => onNext(e.target.value)}>
            <option value="">없음 (여기서 끝)</option>
            {nextOptions.map((o) => (
              <option key={o.id} value={o.id}>{o.id === node.id ? `${o.text} (자기 자신, 반복)` : o.text}</option>
            ))}
          </select>
        </label>
      </div>
      {node.type !== 'start' && (
        <div className="inspector-foot">
          <button className="ghost danger-text" onClick={onDelete}><Icon name="trash" />노드 삭제</button>
          <span className="muted">Delete 키</span>
        </div>
      )}
    </section>
  )
}
