import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  addEdge, Background, Controls, getConnectedEdges, getIncomers, getOutgoers, MarkerType, Panel,
  ReactFlow, useEdgesState, useNodesState, useReactFlow,
} from '@xyflow/react'
import { Hint } from './Hint'
import { Icon } from './icons'
import { episodeTopic, nodeTypesTopic, ros, runWorkflow, statusTopic, stopWorkflow, url } from './ros'
import { CATEGORY_COLORS, defaults, FlowNode, Inspector, JointNames, Specs, START } from './nodes'
import { elapsed, Episodes, Jog, Tabs, Topics, useTick } from './Panels'
import { ConnectionBanner, HealthBar, Notice, RunStatus } from './Status'
import Viewer from './Viewer'

const NODE_W = 220
const GAP = 36
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

function Palette({ specList, colorOf, onAdd }) {
  const [open, setOpen] = useState(() => matchMedia('(min-width: 900px)').matches)
  const groups = [...new Set(specList.map((s) => s.group || '기타'))]
  return (
    <div className="palette">
      <div className="palette-head">
        <button className="palette-toggle" aria-expanded={open} aria-controls="palette-body" onClick={() => setOpen(!open)}>
          <Icon name="plus" />노드 추가<Icon name="chevron" size={14} />
        </button>
        <Hint label="노드 추가 방법">
          노드를 선택한 채로 추가하면 그 다음 단계로 끼워 넣습니다. 선택한 노드는 오른쪽에서 편집하고, Delete 키로 지웁니다. 실행 중에는 Esc로 정지합니다.
        </Hint>
      </div>
      {open && (
        <div className="palette-body" id="palette-body">
          {!specList.length && <p className="muted">실행기 연결을 기다리는 중…</p>}
          {groups.map((g) => (
            <div key={g} role="group" aria-label={g} className="palette-group">
              <span className="palette-group-label">{g}</span>
              {specList.filter((s) => (s.group || '기타') === g).map((s) => (
                <button key={s.type} className="palette-item" style={{ '--cat': colorOf(s.type) }} onClick={() => onAdd(s.type)}>
                  <span className="node-dot" aria-hidden="true" />{s.label}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default function App() {
  // 선택 상태는 저장하지 않는다 (새로고침 후 이전 인스펙터가 열린 채 시작하지 않도록)
  const saved = useState(() => {
    const g = store.get('workflow', DEFAULT)
    return { ...g, nodes: g.nodes.map((n) => ({ ...n, selected: false })) }
  })[0]
  const [nodes, setNodes, onNodesChange] = useNodesState(saved.nodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState(saved.edges)
  const [name, setName] = useState(() => store.get('workflow.name', DEFAULT_NAME))
  const [connected, setConnected] = useState(ros.isConnected)
  const [everConnected, setEverConnected] = useState(ros.isConnected)
  const [notice, setNotice] = useState(null)
  const closeNotice = useCallback(() => setNotice(null), [])
  const flowRef = useRef()
  const fileRef = useRef()
  const { screenToFlowPosition, deleteElements, fitView } = useReactFlow()
  const status = useJsonTopic(statusTopic, { state: 'idle', joints: [] })
  const specList = useJsonTopic(nodeTypesTopic, [])
  const episode = useJsonTopic(episodeTopic, { recording: false, episodes: [], pending: true })
  const names = status.joints || []
  const running = status.state === 'running'

  const specCtx = useMemo(() => {
    const specs = Object.fromEntries(specList.map((s) => [s.type, s]))
    const groups = [...new Set(specList.map((s) => s.group || '기타'))]
    const colorOf = (type) => (type === 'start' ? 'var(--text)'
      : specs[type] ? `var(--cat-${(groups.indexOf(specs[type].group || '기타') % CATEGORY_COLORS) + 1})` : 'var(--warn)')
    return { specs, colorOf }
  }, [specList])
  const { specs, colorOf } = specCtx
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes])
  const labelOf = (id) => {
    if (id === 'jog') return '조그'
    const n = byId.get(id)
    return n ? (n.type === 'start' ? START.label : specs[n.type]?.label ?? n.type) : ''
  }

  // 시작에서 엣지를 따라간 실행 순서 (진행 표시·단계 수·정렬에 사용)
  const steps = useMemo(() => {
    const out = []
    let cur = nodes.find((n) => n.type === 'start')?.id
    while (cur && !out.includes(cur)) {
      out.push(cur)
      cur = edges.find((e) => e.source === cur)?.target
    }
    return out.slice(1)
  }, [nodes, edges])

  // React Flow는 nodeTypes 객체가 바뀔 때마다 경고하므로 타입 목록이 바뀔 때만 새로 만든다
  const typeKey = [...new Set(['start', ...Object.keys(specs), ...nodes.map((n) => n.type)])].sort().join()
  const nodeTypes = useMemo(() => Object.fromEntries(typeKey.split(',').map((t) => [t, FlowNode])), [typeKey])

  useEffect(() => {
    const on = () => { setConnected(true); setEverConnected(true) }
    const off = () => setConnected(false)
    ros.on('connection', on)
    ros.on('close', off)
    return () => { ros.off('connection', on); ros.off('close', off) }
  }, [])

  // 드래그 중 매 프레임 전체 그래프를 직렬화하지 않도록 잠깐 모았다가 저장
  useEffect(() => {
    const t = setTimeout(() => store.set('workflow', { nodes, edges }), 300)
    return () => clearTimeout(t)
  }, [nodes, edges])
  useEffect(() => store.set('workflow.name', name), [name])

  // Esc = 정지 (실행 중일 때). 정지는 언제 눌려도 안전한 방향이라 입력 중이어도 받는다
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && running) stopWorkflow() }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [running])

  const height = (n) => n.measured?.height ?? 72
  const fit = () => requestAnimationFrame(() => fitView({ ...FIT, duration: 200 }))

  const add = (type) => {
    const id = `n${Date.now()}`
    const node = { id, type, data: defaults(specs[type], names), selected: true }
    const sel = nodes.find((n) => n.selected)
    if (sel) {
      // 선택한 노드 바로 뒤에 끼워 넣고, 아래쪽 같은 열의 노드는 한 칸 내린다
      node.position = {
        x: sel.position.x + (sel.type === 'start' ? (sel.measured?.width ?? 80) / 2 - NODE_W / 2 : 0),
        y: sel.position.y + height(sel) + GAP,
      }
      const shift = 72 + GAP
      setNodes((ns) => [...ns.map((n) => ({
        ...n, selected: false,
        position: n.id !== sel.id && Math.abs(n.position.x - node.position.x) < NODE_W && n.position.y >= node.position.y
          ? { ...n.position, y: n.position.y + shift } : n.position,
      })), node])
      setEdges((es) => {
        const out = es.find((e) => e.source === sel.id)
        return [...es.filter((e) => e.source !== sel.id), { id: `${sel.id}-${id}`, source: sel.id, target: id },
          ...(out ? [{ id: `${id}-${out.target}`, source: id, target: out.target }] : [])]
      })
    } else {
      const r = flowRef.current.getBoundingClientRect()
      const c = screenToFlowPosition({ x: r.left + r.width / 2, y: r.top + r.height / 2 })
      node.position = { x: c.x - NODE_W / 2, y: c.y - 36 }
      setNodes((ns) => [...ns.map((n) => ({ ...n, selected: false })), node])
    }
  }

  // 노드당 나가는 엣지는 하나 (분기 노드가 생기기 전까지 실행 순서를 모호하지 않게)
  const onConnect = (c) => setEdges((es) => addEdge(c, es.filter((e) => e.source !== c.source)))

  // 중간 노드를 지우면 앞뒤를 이어서 순서가 끊기지 않게. 삭제는 되돌릴 수 있다
  const onNodesDelete = (deleted) => {
    const prev = { nodes, edges }
    setEdges(deleted.reduce((acc, node) => {
      const ins = getIncomers(node, nodes, edges).filter((n) => n.id !== node.id)
      const outs = getOutgoers(node, nodes, edges).filter((n) => n.id !== node.id)
      const gone = getConnectedEdges([node], edges)
      return [...acc.filter((e) => !gone.includes(e)),
        ...ins.flatMap((a) => outs.map((b) => ({ id: `${a.id}-${b.id}`, source: a.id, target: b.id })))]
    }, edges))
    setNotice({
      tone: 'info',
      text: deleted.length === 1 ? `${labelOf(deleted[0].id)} 노드를 삭제했습니다.` : `노드 ${deleted.length}개를 삭제했습니다.`,
      undo: () => { setNodes(prev.nodes); setEdges(prev.edges) },
    })
  }

  // 드래그 없이 연결하기 (키보드·터치 대안): 인스펙터의 '다음 단계' 선택
  const nextOptions = () => {
    const stepNo = new Map(steps.map((id, i) => [id, i + 1]))
    return nodes.filter((n) => n.type !== 'start').map((n) => ({
      id: n.id, text: `${stepNo.has(n.id) ? `${stepNo.get(n.id)}단계` : '연결 안 됨'}: ${labelOf(n.id)}`,
    }))
  }
  const setNext = (source, target) => setEdges((es) => {
    const rest = es.filter((e) => e.source !== source)
    return target ? addEdge({ source, target }, rest) : rest
  })

  // 실행 순서대로 한 줄로 세우고, 연결 안 된 노드는 오른쪽 열에 모은다
  const layout = () => {
    const pos = {}
    let y = 0
    for (const id of [nodes.find((n) => n.type === 'start')?.id, ...steps].filter(Boolean)) {
      const n = nodes.find((x) => x.id === id)
      pos[id] = { x: n.type === 'start' ? (NODE_W - (n.measured?.width ?? 80)) / 2 : 0, y }
      y += height(n) + GAP
    }
    y = 0
    for (const n of nodes.filter((x) => !pos[x.id])) {
      pos[n.id] = { x: NODE_W + 80, y }
      y += height(n) + GAP
    }
    setNodes((ns) => ns.map((n) => ({ ...n, position: pos[n.id] })))
    fit()
  }

  // 덮어쓰는 동작은 확인 창 대신 되돌리기로 보호
  const replace = (next, nextName, text) => {
    const prev = { nodes, edges, name }
    setNodes(next.nodes)
    setEdges(next.edges)
    setName(nextName)
    fit()
    setNotice({ tone: 'info', text, undo: () => { setNodes(prev.nodes); setEdges(prev.edges); setName(prev.name); fit() } })
  }
  const newWorkflow = () => replace({ nodes: [START_NODE], edges: [] }, DEFAULT_NAME, '새 워크플로를 만들었습니다.')

  const run = () => runWorkflow({
    nodes: nodes.map(({ id, type, data }) => ({ id, type, data })),
    edges: edges.map(({ source, target }) => ({ source, target })),
  })

  const exportJson = () => {
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([JSON.stringify({ nodes, edges }, null, 2)], { type: 'application/json' }))
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
  const shownNodes = useMemo(() => nodes.map((n) => ({
    ...n, deletable: n.type !== 'start',
    className: n.id === status.node && status.state !== 'done' ? `active ${status.state}` : undefined,
  })), [nodes, status.node, status.state])
  const shownEdges = useMemo(() => (running
    ? edges.map((e) => (e.target === status.node ? { ...e, animated: true, className: 'active' } : e))
    : edges), [edges, running, status.node])

  const selected = nodes.filter((n) => n.selected)
  const editing = selected.length === 1 ? selected[0] : null
  const deselect = () => setNodes((ns) => ns.map((n) => (n.selected ? { ...n, selected: false } : n)))

  return (
    <Specs.Provider value={specCtx}>
      <JointNames.Provider value={names}>
        <div className="app">
          <a className="skip-link" href="#workspace">워크플로 편집으로 건너뛰기</a>
          <header className="topbar">
            <h1 translate="no">Physical AI Workflow</h1>
            <HealthBar connected={connected} everConnected={everConnected}
              executor={specList.length > 0} recorder={!episode.pending} />
            <RunStatus status={status} steps={steps} labelOf={labelOf} />
            <RecChip episode={episode} />
            {status.msg && <span className="topbar-msg error-text" title={status.msg}>{status.msg}</span>}
            <span className="spacer" />
            <div className="actions">
              <button className="start-btn" onClick={run} disabled={!connected || running}
                title={!connected ? '실행기와 연결되지 않음' : running ? '실행 중' : '워크플로 실행'}>
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
                <span className="doc-meta">{steps.length}단계</span>
                <span className="spacer" />
                <button className="ghost" onClick={layout} title="실행 순서대로 세로 정렬">
                  <Icon name="layout" /><span className="label">정렬</span>
                </button>
                <button className="ghost" onClick={newWorkflow} title="빈 워크플로로 시작 (되돌리기 가능)">
                  <Icon name="file" /><span className="label">새로 만들기</span>
                </button>
                <button className="ghost" onClick={() => fileRef.current.click()} title="JSON 파일에서 불러오기 (되돌리기 가능)">
                  <Icon name="upload" /><span className="label">불러오기</span>
                </button>
                <button className="ghost" onClick={exportJson} title="JSON 파일로 저장">
                  <Icon name="download" /><span className="label">내보내기</span>
                </button>
                <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={importJson} />
              </div>
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
                  <Panel position="top-left"><Palette specList={specList} colorOf={colorOf} onAdd={add} /></Panel>
                  {editing && (
                    <Panel position="top-right" className="inspector-panel">
                      <Inspector key={editing.id} node={editing} onClose={deselect}
                        onDelete={() => deleteElements({ nodes: [{ id: editing.id }] })}
                        next={edges.find((e) => e.source === editing.id)?.target ?? ''}
                        nextOptions={nextOptions()} onNext={(t) => setNext(editing.id, t)} />
                    </Panel>
                  )}
                  <Background gap={20} />
                  <Controls showInteractive={false} />
                </ReactFlow>
              </div>
            </section>
            <aside aria-label="로봇">
              <Viewer stale={!connected} />
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
