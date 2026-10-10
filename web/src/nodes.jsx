// 워크플로 노드 UI. 노드 타입·분류·아이콘·입력 필드·출력 포트는 실행기(ros/nodes/*.py)가 /workflow/node_types 로
// 알려주고 여기서는 그리기만 한다. 새 노드 타입을 추가해도 이 파일은 고치지 않는다.
// 캔버스의 노드는 요약만(어떤 배율에서도 읽히도록), 편집은 선택했을 때 뜨는 인스펙터에서 실제 크기로 한다.
import { createContext, useContext } from 'react'
import { Handle, Position, useReactFlow } from '@xyflow/react'
import { Icon } from './icons'
import { currentDeg, moveTo } from './ros'

// { specs: type→spec, colorOf: type→CSS 색 } — 분류(group)마다 색 하나
export const Specs = createContext({ specs: {}, colorOf: () => 'var(--muted)' })
export const JointNames = createContext([]) // 로봇 프로파일의 관절 순서

const DEFAULT_OUT = [{ id: 'out', label: '' }]
export const START = { type: 'start', label: '시작', group: '', icon: 'play', fields: [], outputs: DEFAULT_OUT }
export const CATEGORY_COLORS = 6
export const outputsOf = (spec) => (spec?.outputs?.length ? spec.outputs : DEFAULT_OUT)

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
  const outs = outputsOf(spec)
  const labeled = outs.length > 1 || outs[0].label
  return (
    <div className={`node node-${type}${spec ? '' : ' unknown'}`} style={{ '--cat': colorOf(type) }}>
      {type !== 'start' && <Handle type="target" position={Position.Top} />}
      <div className="node-head">
        <span className="node-icon" aria-hidden="true">{spec?.icon ? <Icon name={spec.icon} size={14} /> : <span className="node-dot" />}</span>
        <span className="node-title">{spec?.label ?? type}</span>
        {type !== 'start' && <span className="node-type" translate="no">{type}</span>}
      </div>
      {(!spec || spec.fields.length > 0) && (
        <div className="node-body">
          {!spec && <div className="node-sum warn-text">이 서버에 없는 노드 타입</div>}
          {spec?.fields.filter((f) => !f.advanced).slice(0, 2).map((f) => <div key={f.key} className="node-sum">{summary(f, data[f.key])}</div>)}
        </div>
      )}
      {labeled && (
        <div className="node-ports" aria-hidden="true">
          {outs.map((o) => <span key={o.id}>{o.label}</span>)}
        </div>
      )}
      {outs.map((o, i) => (
        <Handle key={o.id} id={o.id} type="source" position={Position.Bottom} style={{ left: `${((i + 0.5) / outs.length) * 100}%` }} />
      ))}
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
          title="실제 로봇을 이 자세로 움직여 확인">
          실제 로봇으로 이동
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

// 출력 포트별 다음 단계: 드래그 없이 연결(키보드·터치 대안). 한 포트에 둘 이상이면 병렬 실행
function NextSteps({ node, spec, links, options, onAdd, onRemove }) {
  const outs = outputsOf(spec)
  return outs.map((o) => {
    const mine = links.filter((l) => l.port === o.id)
    const free = options.filter((opt) => !mine.some((l) => l.target === opt.id))
    return (
      <div className="field" key={o.id}>
        <span className="field-label">{o.label ? `다음 단계: ${o.label}일 때` : '다음 단계'}</span>
        {mine.map((l) => (
          <div className="link-row" key={l.edgeId}>
            <span>{options.find((opt) => opt.id === l.target)?.text ?? l.target}</span>
            <button className="icon-btn" onClick={() => onRemove(l.edgeId)} aria-label="이 연결 끊기"><Icon name="close" /></button>
          </div>
        ))}
        {mine.length > 1 && <span className="hint-text">{mine.length}개 단계가 동시에 실행됩니다 (병렬). 다시 모으려면 합류 노드를 쓰세요.</span>}
        <select name={`next-${o.id}`} value="" onChange={(e) => e.target.value && onAdd(o.id, e.target.value)}
          aria-label={`${o.label || '다음 단계'} 연결 추가`}>
          <option value="">{mine.length ? '+ 동시에 실행할 단계 추가' : '연결할 단계 선택'}</option>
          {free.map((opt) => <option key={opt.id} value={opt.id}>{opt.id === node.id ? `${opt.text} (자기 자신, 반복)` : opt.text}</option>)}
        </select>
      </div>
    )
  })
}

export function Inspector({ node, onClose, onDelete, onTest, links, options, onAddLink, onRemoveLink }) {
  const { specs, colorOf } = useContext(Specs)
  const spec = node.type === 'start' ? START : specs[node.type]
  const basic = spec?.fields.filter((f) => !f.advanced) ?? []
  const advanced = spec?.fields.filter((f) => f.advanced) ?? []
  return (
    <section className="inspector" aria-label={`${spec?.label ?? node.type} 설정`} style={{ '--cat': colorOf(node.type) }}>
      <div className="inspector-head">
        <span className="node-icon" aria-hidden="true">{spec?.icon ? <Icon name={spec.icon} size={14} /> : <span className="node-dot" />}</span>
        <h2>{spec?.label ?? node.type}</h2>
        {spec?.group && <span className="muted">{spec.group}</span>}
        <button className="icon-btn" onClick={onClose} aria-label="편집 닫기"><Icon name="close" /></button>
      </div>
      <div className="inspector-body">
        {!spec && <p className="warn-text">이 서버에 없는 노드 타입입니다. 실행기에 해당 플러그인(ros/nodes)이 있는지 확인하세요.</p>}
        {basic.map((f) => <Field key={f.key} id={node.id} data={node.data} f={f} />)}
        {advanced.length > 0 && (
          <details className="advanced">
            <summary>고급 설정 <span className="muted">{advanced.length}</span></summary>
            <div className="advanced-body">
              {advanced.map((f) => <Field key={f.key} id={node.id} data={node.data} f={f} />)}
            </div>
          </details>
        )}
        {node.type === 'join' && <p className="hint-text">들어오는 갈래가 모두 도착하면 다음 단계로 한 번 진행합니다.</p>}
        <NextSteps node={node} spec={spec} links={links} options={options} onAdd={onAddLink} onRemove={onRemoveLink} />
      </div>
      {node.type !== 'start' && (
        <div className="inspector-foot">
          <button className="ghost" onClick={onTest} disabled={!spec} title="이 단계만 디지털 트윈에서 실행 (실제 로봇·장비는 그대로)">
            <Icon name="sim" />이 단계만 시뮬레이션
          </button>
          <button className="ghost danger-text" onClick={onDelete}><Icon name="trash" />삭제</button>
        </div>
      )}
    </section>
  )
}
