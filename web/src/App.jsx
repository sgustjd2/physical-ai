import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  addEdge, Background, Controls, MarkerType, Panel, ReactFlow, useEdgesState, useNodesState, useReactFlow,
} from '@xyflow/react'
import { Hint } from './Hint'
import { Icon } from './icons'
import { LibraryMenu } from './Library'
import {
  episodeTopic, libraryTopic, nodeTypesTopic, ros, runWorkflow, sendLibrary, statusTopic, stopWorkflow, url,
} from './ros'
import { CATEGORY_COLORS, defaults, FlowNode, Inspector, JointNames, outputsOf, Specs, START } from './nodes'
import { elapsed, Episodes, Jog, Tabs, Topics, useTick } from './Panels'
import { ConnectionBanner, HealthBar, Notice, RobotMode, RunStatus, StepStrip } from './Status'
import Viewer from './Viewer'

const NODE_W = 220
const GAP = 40
const COL_GAP = 48
const DEFAULT_NAME = '새 워크플로'
// 그래프를 화면에 맞출 때 떠 있는 팔레트(넓은 화면: 왼쪽, 좁은 화면: 위쪽)를 피한다
const FIT = {
  maxZoom: 1,
  padding: matchMedia('(min-width: 900px)').matches
    ? { top: '24px', right: '24px', bottom: '24px', left: '248px' }
    : { top: '64px', right: '16px', bottom: '24px', left: '16px' },
}

const move = (id, y, joints) => ({ id, type: 'move_j', position: { x: 0, y }, data: { joints, duration: 2 } })
const START_NODE = { id: 'n0', type: 'start', position: { x: 70, y: 0 }, data: {} }
const DEFAULT = {
  nodes: [
    START_NODE,
    move('n1', 80, [0, 0, 0, 0, 0, 0]),
    move('n2', 190, [40, 35, 70, 0, 60, 0]),
    { id: 'n3', type: 'wait', position: { x: 0, y: 300 }, data: { sec: 1 } },
    move('n4', 390, [-40, 35, 70, 0, 60, 0]),
    move('n5', 500, [0, 0, 0, 0, 0, 0]),
  ],
}
DEFAULT.edges = DEFAULT.nodes.slice(1).map((n, i) => ({ id: `e${i}`, source: DEFAULT.nodes[i].id, target: n.id }))

const store = {
  get: (k, fallback) => { try { return JSON.parse(localStorage.getItem(k)) ?? fallback } catch { return fallback } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch { /* 저장 불가 환경 */ } },
}

// 저장·비교·전송용 그래프 (React Flow 내부 필드 제외)
const toGraph = (nodes, edges) => ({
  nodes: nodes.map(({ id, type, data, position }) => ({ id, type, data, position })),
  edges: edges.map(({ id, source, target, sourceHandle }) => ({ id, source, target, ...(sourceHandle ? { sourceHandle } : {}) })),
})
const snapshot = (nodes, edges) => JSON.stringify(toGraph(nodes, edges).nodes.map((n) => [n.id, n.type, n.data]))
  + JSON.stringify(edges.map((e) => [e.source, e.target, e.sourceHandle || '']))
const withPositions = (g) => ({ ...g, nodes: g.nodes.map((n) => ({ ...n, position: n.position ?? { x: 0, y: 0 }, selected: false })) })

// latched JSON 토픽 → React state
function useJsonTopic(t, init) {
  const [v, setV] = useState(init)
  useEffect(() => {
    const cb = (m) => setV(JSON.parse(m.data))
    t.subscribe(cb)
    return () => t.unsubscribe(cb)
  }, [t])
  return v
}

function RecChip({ episode }) {
  useTick(1000, episode.recording)
  if (!episode.recording) return null
  return (
    <span className="chip rec" title={episode.current?.task || '작업 설명 없음'}>
      <span className="dot" aria-hidden="true" />녹화 <b>{elapsed(episode.current?.started)}</b>
    </span>
  )
}

function PaletteItem({ s, colorOf, onAdd }) {
  return (
    <button className="palette-item" style={{ '--cat': colorOf(s.type) }} onClick={() => onAdd(s.type)}>
      <span className="node-icon" aria-hidden="true">{s.icon ? <Icon name={s.icon} size={14} /> : <span className="node-dot" />}</span>
      {s.label}
    </button>
  )
}

function Palette({ specList, colorOf, onAdd, live }) {
  const [open, setOpen] = useState(() => matchMedia('(min-width: 900px)').matches)
  const basic = specList.filter((s) => !s.advanced)
  const advanced = specList.filter((s) => s.advanced)
  const groups = [...new Set(basic.map((s) => s.group || '기타'))]
  return (
    <div className="palette">
      <div className="palette-head">
        <button className="palette-toggle" aria-expanded={open} aria-controls="palette-body" onClick={() => setOpen(!open)}>
          <Icon name="plus" />노드 추가<Icon name="chevron" size={14} />
        </button>
        <Hint label="노드 추가 방법">
          노드를 선택한 채로 추가하면 그 다음 단계로 끼워 넣습니다. 한 출력에 여러 단계를 연결하면 동시에 실행되고, 합류 노드에서 다시 모입니다.
          선택한 노드는 오른쪽에서 편집하고 Delete 키로 지웁니다. 실행 중에는 Esc로 정지합니다.
        </Hint>
      </div>
      {open && (
        <div className="palette-body" id="palette-body">
          {!specList.length && <p className="muted">실행기 연결을 기다리는 중…</p>}
          {!!specList.length && !live && <p className="hint-text">마지막으로 받은 노드 목록입니다 (실행기 연결 안 됨).</p>}
          {groups.map((g) => (
            <div key={g} role="group" aria-label={g} className="palette-group">
              <span className="palette-group-label">{g}</span>
              {basic.filter((s) => (s.group || '기타') === g).map((s) => <PaletteItem key={s.type} s={s} colorOf={colorOf} onAdd={onAdd} />)}
            </div>
          ))}
          {advanced.length > 0 && (
            <details className="palette-advanced">
              <summary>고급 <span className="muted">ROS 토픽 직접 다루기</span></summary>
              {advanced.map((s) => <PaletteItem key={s.type} s={s} colorOf={colorOf} onAdd={onAdd} />)}
            </details>
          )}
        </div>
      )}
    </div>
  )
}

export default function App() {
  // 선택 상태는 저장하지 않는다 (새로고침 후 이전 인스펙터가 열린 채 시작하지 않도록)
  const saved = useState(() => withPositions(store.get('workflow', DEFAULT)))[0]
  const [nodes, setNodes, onNodesChange] = useNodesState(saved.nodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState(saved.edges)
  const [name, setName] = useState(() => store.get('workflow.name', DEFAULT_NAME))
  const [savedSnap, setSavedSnap] = useState(() => store.get('workflow.savedSnap', null)) // GB10에 마지막으로 저장/연 내용
  const [view, setView] = useState(() => store.get('view', 'edit')) // edit: 워크플로 편집 중심, twin: 디지털 트윈 중심
  const [connected, setConnected] = useState(ros.isConnected)
  const [everConnected, setEverConnected] = useState(ros.isConnected)
  const [notice, setNotice] = useState(null)
  const closeNotice = useCallback(() => setNotice(null), [])
  const flowRef = useRef()
  const fileRef = useRef()
  const pendingSave = useRef(null)
  const { screenToFlowPosition, deleteElements, fitView } = useReactFlow()
  const status = useJsonTopic(statusTopic, { state: 'idle', joints: [], active: [] })
  const episode = useJsonTopic(episodeTopic, { recording: false, episodes: [], pending: true })
  const library = useJsonTopic(libraryTopic, { items: [], pending: true })
  // 노드 타입은 마지막으로 받은 것을 저장해 두어, 연결이 끊겨도 이름·색이 유지되게 한다
  const [specList, setSpecList] = useState(() => store.get('nodeTypes', []))
  const [specsLive, setSpecsLive] = useState(false)
  const names = status.joints || []
  const running = status.state === 'running'
  const active = status.active || []

  useEffect(() => {
    const cb = (m) => { const v = JSON.parse(m.data); setSpecList(v); setSpecsLive(true); store.set('nodeTypes', v) }
    nodeTypesTopic.subscribe(cb)
    return () => nodeTypesTopic.unsubscribe(cb)
  }, [])

  const specCtx = useMemo(() => {
    const specs = Object.fromEntries(specList.map((s) => [s.type, s]))
    const groups = [...new Set(specList.map((s) => s.group || '기타'))]
    const colorOf = (type) => (type === 'start' ? 'var(--text)'
      : specs[type] ? `var(--cat-${(groups.indexOf(specs[type].group || '기타') % CATEGORY_COLORS) + 1})` : 'var(--warn)')
    return { specs, colorOf }
  }, [specList])
  const { specs, colorOf } = specCtx
  const specOf = (type) => (type === 'start' ? START : specs[type])
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes])
  const labelOf = (id) => {
    if (id === 'jog') return '조그'
    const n = byId.get(id)
    return n ? specOf(n.type)?.label ?? n.type : ''
  }
  const portOf = (e) => e.sourceHandle || outputsOf(specOf(byId.get(e.source)?.type))[0].id

  // 시작에서 도달하는 노드를 너비 우선으로 (진행 표시·단계 번호·자동 배치에 사용)
  const { steps, depth } = useMemo(() => {
    const out = new Map()
    for (const e of edges) out.set(e.source, [...(out.get(e.source) || []), e.target])
    const start = nodes.find((n) => n.type === 'start')
    const d = new Map(start ? [[start.id, 0]] : [])
    const q = start ? [start.id] : []
    while (q.length) {
      const id = q.shift()
      for (const t of out.get(id) || []) if (!d.has(t) && byId.has(t)) { d.set(t, d.get(id) + 1); q.push(t) }
    }
    return { steps: [...d.keys()].slice(1), depth: d }
  }, [nodes, edges, byId])

  // React Flow는 nodeTypes 객체가 바뀔 때마다 경고하므로 타입 목록이 바뀔 때만 새로 만든다
  const typeKey = [...new Set(['start', ...Object.keys(specs), ...nodes.map((n) => n.type)])].sort().join()
  const nodeTypes = useMemo(() => Object.fromEntries(typeKey.split(',').map((t) => [t, FlowNode])), [typeKey])

  useEffect(() => {
    const on = () => { setConnected(true); setEverConnected(true) }
    const off = () => { setConnected(false); setSpecsLive(false) }
    ros.on('connection', on)
    ros.on('close', off)
    return () => { ros.off('connection', on); ros.off('close', off) }
  }, [])

  // 드래그 중 매 프레임 전체 그래프를 직렬화하지 않도록 잠깐 모았다가 저장
  useEffect(() => {
    const t = setTimeout(() => store.set('workflow', toGraph(nodes, edges)), 300)
    return () => clearTimeout(t)
  }, [nodes, edges])
  useEffect(() => store.set('workflow.name', name), [name])
  useEffect(() => store.set('workflow.savedSnap', savedSnap), [savedSnap])
  useEffect(() => store.set('view', view), [view])

  // Esc = 정지 (실행 중일 때). 정지는 언제 눌려도 안전한 방향이라 입력 중이어도 받는다
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && running) stopWorkflow() }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [running])

  // 서버 저장 응답
  useEffect(() => {
    const p = pendingSave.current
    if (!p || library.ack !== p.id) return
    pendingSave.current = null
    if (library.error) setNotice({ tone: 'error', text: `저장하지 못했습니다: ${library.error}` })
    else {
      setSavedSnap(p.snap)
      setNotice({ tone: 'info', text: `${p.name}을(를) GB10에 저장했습니다. 다른 화면에서도 '열기'로 쓸 수 있습니다.` })
    }
  }, [library])

  const height = (n) => n.measured?.height ?? 72
  const fit = () => requestAnimationFrame(() => fitView({ ...FIT, duration: 200 }))

  const add = (type) => {
    const id = `n${Date.now()}`
    const node = { id, type, data: defaults(specs[type], names), selected: true }
    const sel = nodes.find((n) => n.selected)
    if (sel) {
      // 선택한 노드의 첫 출력 바로 뒤에 끼워 넣고, 아래쪽 같은 열의 노드는 한 칸 내린다
      const port = outputsOf(specOf(sel.type))[0].id
      const newPort = outputsOf(specs[type])[0].id
      node.position = {
        x: sel.position.x + ((sel.measured?.width ?? NODE_W) - NODE_W) / 2,
        y: sel.position.y + height(sel) + GAP,
      }
      setNodes((ns) => [...ns.map((n) => ({
        ...n, selected: false,
        position: n.id !== sel.id && Math.abs(n.position.x - node.position.x) < NODE_W && n.position.y >= node.position.y
          ? { ...n.position, y: n.position.y + 72 + GAP } : n.position,
      })), node])
      setEdges((es) => {
        const moved = es.filter((e) => e.source === sel.id && portOf(e) === port)
        return [...es.filter((e) => !moved.includes(e)),
          { id: `${sel.id}-${port}-${id}`, source: sel.id, target: id, ...(port !== 'out' ? { sourceHandle: port } : {}) },
          ...moved.map((e) => ({ id: `${id}-${newPort}-${e.target}`, source: id, target: e.target, ...(newPort !== 'out' ? { sourceHandle: newPort } : {}) }))]
      })
    } else {
      const r = flowRef.current.getBoundingClientRect()
      const c = screenToFlowPosition({ x: r.left + r.width / 2, y: r.top + r.height / 2 })
      node.position = { x: c.x - NODE_W / 2, y: c.y - 36 }
      setNodes((ns) => [...ns.map((n) => ({ ...n, selected: false })), node])
    }
  }

  // 한 출력에서 여러 단계로 연결하면 병렬 실행 (같은 연결 중복만 막는다)
  const onConnect = (c) => setEdges((es) => addEdge({ ...c, id: `${c.source}-${c.sourceHandle || 'out'}-${c.target}` }, es))

  // 들어오는 연결이 하나뿐인 중간 노드를 지우면 앞뒤를 잇는다. 삭제는 되돌릴 수 있다
  const onNodesDelete = (deleted) => {
    const prev = { nodes, edges }
    const gone = new Set(deleted.map((n) => n.id))
    let next = edges.filter((e) => !gone.has(e.source) && !gone.has(e.target))
    for (const n of deleted) {
      const ins = edges.filter((e) => e.target === n.id && e.source !== n.id)
      const outs = edges.filter((e) => e.source === n.id && e.target !== n.id)
      if (ins.length === 1 && !gone.has(ins[0].source)) {
        for (const o of outs.filter((e) => !gone.has(e.target))) {
          next = addEdge({ id: `${ins[0].source}-${ins[0].sourceHandle || 'out'}-${o.target}`, source: ins[0].source, sourceHandle: ins[0].sourceHandle, target: o.target }, next)
        }
      }
    }
    setEdges(next)
    setNotice({
      tone: 'info',
      text: deleted.length === 1 ? `${labelOf(deleted[0].id)} 노드를 삭제했습니다.` : `노드 ${deleted.length}개를 삭제했습니다.`,
      undo: () => { setNodes(prev.nodes); setEdges(prev.edges) },
    })
  }

  // 드래그 없이 연결하기 (키보드·터치 대안): 인스펙터의 출력별 '다음 단계'
  const stepNo = new Map(steps.map((id, i) => [id, i + 1]))
  const linkOptions = () => nodes.filter((n) => n.type !== 'start').map((n) => ({
    id: n.id, text: `${stepNo.has(n.id) ? `${stepNo.get(n.id)}.` : '(연결 안 됨)'} ${labelOf(n.id)}`,
  }))
  const linksOf = (id) => edges.filter((e) => e.source === id).map((e) => ({ edgeId: e.id, port: portOf(e), target: e.target }))
  const addLink = (source, port, target) => onConnect({ source, target, sourceHandle: port === 'out' ? null : port })
  const removeLink = (edgeId) => setEdges((es) => es.filter((e) => e.id !== edgeId))

  // 자동 배치: 시작에서의 거리(깊이)별로 한 줄씩, 같은 깊이는 옆으로 (분기·병렬이 나란히 보이게)
  const layout = () => {
    const rows = []
    for (const [id, d] of depth) (rows[d] ||= []).push(id)
    const pos = {}
    let y = 0
    for (const row of rows) {
      row.forEach((id, i) => {
        const w = byId.get(id).measured?.width ?? NODE_W
        pos[id] = { x: (i - (row.length - 1) / 2) * (NODE_W + COL_GAP) + (NODE_W - w) / 2, y }
      })
      y += Math.max(...row.map((id) => height(byId.get(id)))) + GAP
    }
    const right = (Math.max(1, ...rows.map((r) => r.length)) / 2) * (NODE_W + COL_GAP) + 80
    y = 0
    for (const n of nodes.filter((x) => !pos[x.id])) {
      pos[n.id] = { x: right, y }
      y += height(n) + GAP
    }
    setNodes((ns) => ns.map((n) => ({ ...n, position: pos[n.id] })))
    fit()
  }

  // 덮어쓰는 동작은 확인 창 대신 되돌리기로 보호
  const replace = (next, nextName, text, snap = null) => {
    const prev = { nodes, edges, name, savedSnap }
    const g = withPositions(next)
    setNodes(g.nodes)
    setEdges(g.edges)
    setName(nextName)
    setSavedSnap(snap)
    fit()
    setNotice({ tone: 'info', text, undo: () => { setNodes(prev.nodes); setEdges(prev.edges); setName(prev.name); setSavedSnap(prev.savedSnap); fit() } })
  }
  const newWorkflow = () => replace({ nodes: [START_NODE], edges: [] }, DEFAULT_NAME, '새 워크플로를 만들었습니다.')
  // example=true: 예제는 서버에 없으므로 '저장 안 됨'으로 연다
  const openFromServer = (w, example = false) => {
    const g = withPositions(w.graph)
    replace(g, w.name.replace(/^예제: /, ''), `${w.name}을(를) 열었습니다.`, example ? null : snapshot(g.nodes, g.edges))
  }
  const deleteFromServer = (w) => {
    sendLibrary('delete', { name: w.name })
    setNotice({ tone: 'info', text: `${w.name}을(를) GB10에서 삭제했습니다.`, undo: () => sendLibrary('save', { name: w.name, graph: w.graph }) })
  }
  const saveToServer = () => {
    const nm = name.trim() || DEFAULT_NAME
    pendingSave.current = { id: sendLibrary('save', { name: nm, graph: toGraph(nodes, edges) }), snap: snapshot(nodes, edges), name: nm }
  }
  const dirty = savedSnap !== snapshot(nodes, edges)

  const runGraph = (ns = nodes, es = edges) => ({
    nodes: ns.map(({ id, type, data }) => ({ id, type, data })),
    edges: es.map(({ source, target, sourceHandle }) => ({ source, target, ...(sourceHandle ? { sourceHandle } : {}) })),
  })
  const testNode = (n) => runWorkflow({
    nodes: [{ id: 'start', type: 'start' }, { id: n.id, type: n.type, data: n.data }],
    edges: [{ source: 'start', target: n.id }],
  }, 'sim')

  const exportJson = () => {
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([JSON.stringify(toGraph(nodes, edges), null, 2)], { type: 'application/json' }))
    a.download = `${name.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'workflow'}.json`
    a.click()
    URL.revokeObjectURL(a.href)
  }
  const importJson = async (e) => {
    const f = e.target.files[0]
    e.target.value = ''
    if (!f) return
    try {
      const g = JSON.parse(await f.text())
      if (!Array.isArray(g.nodes) || !Array.isArray(g.edges)) throw new Error('nodes와 edges 배열이 없습니다')
      replace(g, f.name.replace(/\.json$/i, ''), `${f.name}을(를) 불러왔습니다.`)
    } catch (err) {
      setNotice({ tone: 'error', text: `${f.name}을(를) 불러오지 못했습니다: ${err.message}. 이 화면에서 내보낸 워크플로 JSON 파일인지 확인하세요.` })
    }
  }

  // 표시용 노드·엣지: 실행 상태가 바뀔 때만 새로 만든다 (이름 입력 등 무관한 갱신에 전체 노드가 다시 그려지지 않게)
  const shownNodes = useMemo(() => nodes.map((n) => {
    const on = active.includes(n.id) || (n.id === status.node && ['error', 'stopped'].includes(status.state))
    return { ...n, deletable: n.type !== 'start', className: on ? `active ${status.state}` : undefined }
  }), [nodes, active, status.node, status.state])
  const shownEdges = useMemo(() => edges.map((e) => {
    const outs = outputsOf(specOf(byId.get(e.source)?.type))
    const label = outs.length > 1 ? outs.find((o) => o.id === portOf(e))?.label : undefined
    const hot = running && active.includes(e.target)
    return label || hot ? { ...e, label, animated: hot, className: hot ? 'active' : undefined } : e
  }), [edges, byId, specs, running, active])

  const selected = nodes.filter((n) => n.selected)
  const editing = selected.length === 1 ? selected[0] : null
  const deselect = () => setNodes((ns) => ns.map((n) => (n.selected ? { ...n, selected: false } : n)))
  const toggleSelect = (id) => setNodes((ns) => ns.map((n) => ({ ...n, selected: n.id === id ? !n.selected : false })))

  // 트윈 고스트: 선택한 MoveJ 단계의 목표 자세 (실행 전에 3D로 확인)
  const ghost = useMemo(() => {
    if (editing?.type !== 'move_j' || !names.length) return null
    return Object.fromEntries(names.map((n, i) => [n, (Number(editing.data.joints?.[i]) || 0) * Math.PI / 180]))
  }, [editing, names])
  const simRun = running && status.mode === 'sim'
  const viewer = <Viewer large={view === 'twin'} stale={!connected} ghost={ghost} followCommand={running && !simRun} simRun={simRun} />

  return (
    <Specs.Provider value={specCtx}>
      <JointNames.Provider value={names}>
        <div className="app">
          <a className="skip-link" href="#workspace">워크플로 편집으로 건너뛰기</a>
          <header className="topbar">
            <h1 translate="no">Physical AI Workflow</h1>
            <RobotMode connected={connected} />
            <HealthBar connected={connected} everConnected={everConnected}
              executor={specsLive} recorder={!episode.pending} />
            <RunStatus status={status} steps={steps} labelOf={labelOf} />
            <RecChip episode={episode} />
            {status.msg && <span className="topbar-msg error-text" title={status.msg}>{status.msg}</span>}
            <span className="spacer" />
            <div className="actions">
              <button className="sim-btn" onClick={() => runWorkflow(runGraph(), 'sim')} disabled={!connected || running}
                title="디지털 트윈에서만 실행합니다. 실제 로봇·장비는 움직이지 않습니다">
                <Icon name="sim" />시뮬레이션
              </button>
              <button className="start-btn" onClick={() => runWorkflow(runGraph(), 'real')} disabled={!connected || running}
                title={!connected ? '실행기와 연결되지 않음' : running ? '실행 중' : '실제 로봇으로 실행'}>
                <Icon name="play" />실행
              </button>
              <button className="danger" onClick={stopWorkflow} disabled={!connected} aria-keyshortcuts="Escape"
                title="정지 (Esc). 진행 중인 동작을 취소하며, 비상정지(E-stop)를 대신하지 않습니다">
                <Icon name="stop" />정지
              </button>
            </div>
          </header>
          <ConnectionBanner connected={connected} everConnected={everConnected} url={url} />
          <Notice notice={notice} onClose={closeNotice} />
          <main>
            <section className="workspace" id="workspace" tabIndex={-1} aria-label="워크플로">
              <div className="docbar">
                <input className="doc-name" name="workflowName" autoComplete="off" value={name} onChange={(e) => setName(e.target.value)}
                  onBlur={() => !name.trim() && setName(DEFAULT_NAME)} aria-label="워크플로 이름" spellCheck={false} />
                <span className={`doc-state${dirty ? ' dirty' : ''}`} title={dirty ? 'GB10에 저장되지 않은 변경이 있습니다' : 'GB10에 저장된 내용과 같습니다'}>
                  {dirty ? '저장 안 됨' : '저장됨'}
                </span>
                <span className="doc-meta">{steps.length}단계</span>
                <span className="spacer" />
                <div className="segmented view-switch" role="radiogroup" aria-label="보기">
                  <button role="radio" aria-checked={view === 'edit'} onClick={() => setView('edit')}>편집</button>
                  <button role="radio" aria-checked={view === 'twin'} onClick={() => setView('twin')}>트윈</button>
                </div>
                {view === 'edit' && (
                  <button className="ghost" onClick={layout} title="실행 순서대로 자동 배치 (분기·병렬은 옆으로)">
                    <Icon name="layout" /><span className="label">정렬</span>
                  </button>
                )}
                <button className="ghost" onClick={newWorkflow} title="빈 워크플로로 시작 (되돌리기 가능)">
                  <Icon name="file" /><span className="label">새로 만들기</span>
                </button>
                <LibraryMenu items={library.items || []} connected={connected && !library.pending} onOpen={openFromServer}
                  onDelete={deleteFromServer} onImportFile={() => fileRef.current.click()} onExportFile={exportJson} />
                <button className="ghost save-btn" onClick={saveToServer} disabled={!connected}
                  title="GB10에 저장 (같은 이름이면 덮어씀). 저장하면 다른 화면에서도 열 수 있습니다">
                  <Icon name="save" /><span className="label">저장</span>
                </button>
                <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={importJson} />
              </div>
              {view === 'twin' ? (
                <div className="twin">
                  {viewer}
                  <StepStrip steps={steps} status={status} labelOf={labelOf} selectedId={editing?.id} onSelect={toggleSelect} />
                </div>
              ) : (
                <div className="flow" ref={flowRef}>
                  <ReactFlow
                    nodes={shownNodes}
                    edges={shownEdges}
                    nodeTypes={nodeTypes}
                    onNodesChange={onNodesChange}
                    onEdgesChange={onEdgesChange}
                    onConnect={onConnect}
                    onNodesDelete={onNodesDelete}
                    deleteKeyCode={['Backspace', 'Delete']}
                    defaultEdgeOptions={{ type: 'smoothstep', markerEnd: { type: MarkerType.ArrowClosed } }}
                    colorMode="system"
                    fitView
                    fitViewOptions={FIT}
                    minZoom={0.2}
                  >
                    <Panel position="top-left"><Palette specList={specList} colorOf={colorOf} onAdd={add} live={specsLive} /></Panel>
                    {editing && (
                      <Panel position="top-right" className="inspector-panel">
                        <Inspector key={editing.id} node={editing} onClose={deselect}
                          onDelete={() => deleteElements({ nodes: [{ id: editing.id }] })}
                          onTest={() => testNode(editing)}
                          links={linksOf(editing.id)} options={linkOptions()}
                          onAddLink={(port, target) => addLink(editing.id, port, target)} onRemoveLink={removeLink} />
                      </Panel>
                    )}
                    <Background gap={20} />
                    <Controls showInteractive={false} />
                  </ReactFlow>
                </div>
              )}
            </section>
            <aside aria-label="로봇">
              {view === 'edit' && viewer}
              <Jog names={names} disabled={!connected || (running && status.node !== 'jog')} />
              <Tabs tabs={[
                { id: 'rec', label: <>녹화{episode.recording && <span className="tab-dot" aria-label="녹화 중" />}</>, content: <Episodes episode={episode} connected={connected} /> },
                { id: 'topics', label: '토픽', content: <Topics connected={connected} /> },
              ]} />
            </aside>
          </main>
        </div>
      </JointNames.Provider>
    </Specs.Provider>
  )
}
