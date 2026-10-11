import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import {
  addEdge, Background, Controls, MarkerType, Panel, ReactFlow, useEdgesState, useNodesState, useReactFlow,
} from '@xyflow/react'
import { AIBuilder } from './AIBuilder'
import { CameraPanel } from './Camera'
import { anchorOf, BlockPicker } from './BlockPicker'
import { checkGraph } from './check'
import { copyText, instantiate, parseClip, restoreLinks } from './clipboard'
import { Hint } from './Hint'
import { createHistory } from './history'
import { checkMotion, motionPlan } from './motionPlan'
import { robotModel } from './robotModel'
import { Icon } from './icons'
import { LibraryMenu } from './Library'
import {
  datasetsTopic, episodeTopic, runsTopic, generateTopic, libraryTopic, logTopic, moveHome, nodeTypesTopic, onRobotInfo, robotInfo, ros, runWorkflow, sendLibrary, setEstop, statusTopic, stopWorkflow, url,
} from './ros'
import { CATEGORY_COLORS, defaults, FlowEdge, FlowNode, Inspector, Issues, JointNames, NodeActions, outputsOf, Robot, Specs, START } from './nodes'
import { elapsed, Episodes, Jog, Logs, Tabs, Topics, useTick } from './Panels'
import { OpsView } from './Ops'
import { Segmented } from './Segmented'
import { ConnectionBanner, EstopBanner, HealthBar, Notice, RobotMode, RunStatus, StepStrip } from './Status'
import Viewer from './Viewer'

const NODE_W = 220
const GAP = 40
const COL_GAP = 48
const DEFAULT_NAME = '새 워크플로'
// 그래프를 화면에 맞출 때 왼쪽 위 '블록 추가' 버튼을 피한다
const FIT = { maxZoom: 1, padding: { top: '64px', right: '24px', bottom: '24px', left: '24px' } }
const EDGE_TYPES = { flow: FlowEdge }
const EDGE_DEFAULTS = { type: 'flow', markerEnd: { type: MarkerType.ArrowClosed } }
const link = (source, port, target) => ({ id: `${source}-${port}-${target}`, source, target, ...(port !== 'out' ? { sourceHandle: port } : {}) })

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

// 자동 배치: 시작에서의 거리(깊이)별로 한 줄씩, 같은 깊이는 옆으로 (분기·병렬이 나란히 보이게). 연결 안 된 노드는 오른쪽 열
function arrange(nodes, edges) {
  const h = (n) => n.measured?.height ?? 72
  const out = new Map()
  for (const e of edges) out.set(e.source, [...(out.get(e.source) || []), e.target])
  const start = nodes.find((n) => n.type === 'start')
  const depth = new Map(start ? [[start.id, 0]] : [])
  const q = start ? [start.id] : []
  while (q.length) {
    const id = q.shift()
    for (const t of out.get(id) || []) if (!depth.has(t) && nodes.some((n) => n.id === t)) { depth.set(t, depth.get(id) + 1); q.push(t) }
  }
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const rows = []
  for (const [id, d] of depth) (rows[d] ||= []).push(id)
  const pos = {}
  let y = 0
  for (const row of rows) {
    row.forEach((id, i) => {
      const w = byId.get(id).measured?.width ?? NODE_W
      pos[id] = { x: (i - (row.length - 1) / 2) * (NODE_W + COL_GAP) + (NODE_W - w) / 2, y }
    })
    y += Math.max(...row.map((id) => h(byId.get(id)))) + GAP
  }
  const right = (Math.max(1, ...rows.map((r) => r.length)) / 2) * (NODE_W + COL_GAP) + 80
  y = 0
  for (const n of nodes.filter((x) => !pos[x.id])) {
    pos[n.id] = { x: right, y }
    y += h(n) + GAP
  }
  return nodes.map((n) => ({ ...n, position: pos[n.id] }))
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

export default function App() {
  // 선택 상태는 저장하지 않는다 (새로고침 후 이전 인스펙터가 열린 채 시작하지 않도록)
  const saved = useState(() => withPositions(store.get('workflow', DEFAULT)))[0]
  const [nodes, setNodes, onNodesChange] = useNodesState(saved.nodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState(saved.edges)
  const [name, setName] = useState(() => store.get('workflow.name', DEFAULT_NAME))
  const [savedSnap, setSavedSnap] = useState(() => store.get('workflow.savedSnap', null)) // GB10에 마지막으로 저장/연 내용
  const [view, setView] = useState(() => store.get('view', 'edit')) // edit: 워크플로 편집, twin: 디지털 트윈, ops: 운영(현장 작업자)
  const [camView, setCamView] = useState(() => store.get('cameraView', '')) // 화면으로 볼 카메라 ('' = 프로파일 기본). 카메라 탭과 트윈 보기가 같이 씀
  const [connected, setConnected] = useState(ros.isConnected)
  const [everConnected, setEverConnected] = useState(ros.isConnected)
  const [notice, setNotice] = useState(null)
  const [picker, setPicker] = useState(null) // { anchor, title, at }
  const closePicker = useCallback(() => setPicker(null), [])
  const closeNotice = useCallback(() => setNotice(null), [])
  const flowRef = useRef()
  const fileRef = useRef()
  const pendingSave = useRef(null)
  const { screenToFlowPosition, deleteElements, fitView } = useReactFlow()
  const status = useJsonTopic(statusTopic, { state: 'idle', joints: [], active: [] })
  const episode = useJsonTopic(episodeTopic, { recording: false, episodes: [], pending: true })
  const library = useJsonTopic(libraryTopic, { items: [], pending: true })
  const log = useJsonTopic(logTopic, { entries: [] })
  const gen = useJsonTopic(generateTopic, {})
  const datasets = useJsonTopic(datasetsTopic, null) // null = 아직 못 받음
  const runs = useJsonTopic(runsTopic, null) // 운영 화면 KPI (null = 아직 못 받음)
  // 노드 타입은 마지막으로 받은 것을 저장해 두어, 연결이 끊겨도 이름·색이 유지되게 한다
  const [specList, setSpecList] = useState(() => store.get('nodeTypes', []))
  const [specsLive, setSpecsLive] = useState(false)
  const names = status.joints || []
  const robotCtx = useMemo(() => ({ camera: status.camera || '', connected, datasets }), [status.camera, connected, datasets])
  const estop = !!status.estop
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
      : specs[type] ? `var(--cat-${(groups.indexOf(specs[type].group || '기타') % CATEGORY_COLORS) + 1})`
      : specList.length ? 'var(--warn)' : 'var(--muted)') // 목록을 아직 못 받았으면 경고색 대신 중립색
    return { specs, colorOf, loaded: specList.length > 0 }
  }, [specList])
  const { specs, colorOf } = specCtx
  const specOf = (type) => (type === 'start' ? START : specs[type])
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes])
  const labelOf = (id) => {
    if (id === 'jog') return '조그'
    if (id === '__home') return '홈 위치로 이동'
    const n = byId.get(id)
    return n ? n.data?.title || (specOf(n.type)?.label ?? n.type) : ''
  }
  const portOf = (e) => e.sourceHandle || outputsOf(specOf(byId.get(e.source)?.type))[0].id

  // 시작에서 도달하는 노드를 너비 우선으로 (진행 표시·단계 번호·자동 배치에 사용)
  const steps = useMemo(() => {
    const out = new Map()
    for (const e of edges) out.set(e.source, [...(out.get(e.source) || []), e.target])
    const start = nodes.find((n) => n.type === 'start')
    const d = new Map(start ? [[start.id, 0]] : [])
    const q = start ? [start.id] : []
    while (q.length) {
      const id = q.shift()
      for (const t of out.get(id) || []) if (!d.has(t) && byId.has(t)) { d.set(t, d.get(id) + 1); q.push(t) }
    }
    return [...d.keys()].slice(1)
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
  useEffect(() => store.set('cameraView', camView), [camView])

  // 되돌리기/다시 하기 (history.js): 그래프·이름의 변화를 여기 한 곳에서 기록하므로 편집 동작마다 기록 코드가 필요 없다
  const histKey = useMemo(() => JSON.stringify({ g: toGraph(nodes, edges), name }), [nodes, edges, name])
  const histSig = useMemo(() => `${nodes.map((n) => n.id)}|${edges.map((e) => e.id)}`, [nodes, edges])
  const history = useState(() => createHistory(histKey))[0]
  const [, setHistVer] = useState(0)
  useEffect(() => { history.change(histKey, histSig, performance.now()) }, [history, histKey, histSig])
  const canUndo = history.canUndo || histKey !== history.last
  const canRedo = history.canRedo && histKey === history.last
  const restore = (key) => {
    if (!key) return
    const { g, name: nm } = JSON.parse(key)
    const cur = new Map(nodes.map((n) => [n.id, n]))
    // 크기·선택은 지금 값을 이어 써서 다시 측정하는 동안 깜빡이지 않게
    setNodes(g.nodes.map((n) => ({ ...n, measured: cur.get(n.id)?.measured, selected: !!cur.get(n.id)?.selected })))
    setEdges(g.edges)
    setName(nm)
    setHistVer((v) => v + 1)
  }
  const undo = () => restore(history.undo())
  const redo = () => restore(history.redo())

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

  // at: { source, port } 그 출력 바로 뒤에 끼워 넣기 (원래 이어지던 단계는 새 블록 뒤로)
  //     { edge } 그 연결 사이에 끼워 넣기
  //     없음 → 선택한 노드 뒤, 선택이 없으면 화면 가운데
  const add = (type, at) => {
    const id = `n${Date.now()}`
    const node = { id, type, data: defaults(specs[type], names), selected: true }
    const newPort = outputsOf(specs[type])[0].id
    const edge = at?.edge && edges.find((e) => e.id === at.edge)
    const src = edge ? byId.get(edge.source) : at?.source ? byId.get(at.source) : nodes.find((n) => n.selected)
    if (!src) {
      const r = flowRef.current.getBoundingClientRect()
      const c = screenToFlowPosition({ x: r.left + r.width / 2, y: r.top + r.height / 2 })
      node.position = { x: c.x - NODE_W / 2, y: c.y - 36 }
      setNodes((ns) => [...ns.map((n) => ({ ...n, selected: false })), node])
      return
    }
    const port = edge ? portOf(edge) : at?.port ?? outputsOf(specOf(src.type))[0].id
    const moved = edge ? [edge] : edges.filter((e) => e.source === src.id && portOf(e) === port)
    // 출력이 여럿이면(예/아니오…) 그 출력 쪽 열에 놓는다
    const outs = outputsOf(specOf(src.type))
    const i = Math.max(0, outs.findIndex((o) => o.id === port))
    const col = outs.length > 1 ? (i - (outs.length - 1) / 2) * (NODE_W + COL_GAP) : 0
    const tgt = edge && byId.get(edge.target)
    node.position = tgt && tgt.position.y > src.position.y
      ? { ...tgt.position }
      : { x: src.position.x + ((src.measured?.width ?? NODE_W) - NODE_W) / 2 + col, y: src.position.y + height(src) + GAP }
    // 아래쪽 같은 열의 노드는 한 칸 내린다
    setNodes((ns) => [...ns.map((n) => ({
      ...n, selected: false,
      position: n.id !== src.id && Math.abs(n.position.x - node.position.x) < NODE_W && n.position.y >= node.position.y
        ? { ...n.position, y: n.position.y + 72 + GAP } : n.position,
    })), node])
    setEdges((es) => [...es.filter((e) => !moved.includes(e)), link(src.id, port, id), ...moved.map((e) => link(id, newPort, e.target))])
  }

  const duplicate = (id) => {
    const n = byId.get(id)
    const copy = { id: `n${Date.now()}`, type: n.type, data: structuredClone(n.data), position: { x: n.position.x + 32, y: n.position.y + 32 }, selected: true }
    setNodes((ns) => [...ns.map((x) => ({ ...x, selected: false })), copy])
  }

  // 복사/붙여넣기 (clipboard.js). 복사한 글자는 앱 안에도 들고 있어 붙여넣기 버튼(터치 화면)에 쓴다.
  // doc: 지금 열린 워크플로 번호 (새로 만들기·열기·불러오기마다 바뀜) — 잘라낸 블록을 같은 워크플로에 붙일 때 원래 자리로
  const doc = useRef(0)
  const clip = useRef({ text: null, pastes: 0, cut: false, doc: 0, links: null })
  const bridged = useRef([]) // 마지막 삭제에서 앞뒤를 이어 붙이며 새로 생긴 연결 id (onNodesDelete가 기록)
  const [clipCount, setClipCount] = useState(0)
  const copyNodes = (cut = false) => {
    const text = copyText(nodes, edges)
    if (!text) return null
    const n = parseClip(text).nodes.length
    clip.current = { text, pastes: 0, cut, doc: doc.current }
    setClipCount(n)
    if (cut) {
      // 되돌려 붙일 때 다시 이을 바깥 연결 (잘라낸 블록 ↔ 남은 블록). other: 상대 블록 이름 (그새 지워지면 알림에 씀)
      const ids = new Set(parseClip(text).nodes.map((x) => x.id))
      const external = edges.filter((e) => ids.has(e.source) !== ids.has(e.target))
        .map(({ source, target, sourceHandle }) => ({ source, target, sourceHandle, other: labelOf(ids.has(source) ? target : source) }))
      deleteElements({ nodes: [...ids].map((id) => ({ id })) })
        .then(() => { clip.current.links = { external, bridges: bridged.current } })
        .then(() => setNotice({ tone: 'info', text: `블록 ${n}개를 잘라냈습니다. 붙여넣으면 원래 자리로 돌아갑니다.` }))
    } else {
      setNotice({ tone: 'info', text: `블록 ${n}개를 복사했습니다. 붙여넣기 버튼이나 Ctrl+V로 붙입니다.` })
    }
    return text
  }
  // 붙여넣기 알림: 잘라낸 블록의 연결이 일부만 돌아왔으면 경고로, 이어질 블록이 지워진 것을 알린다
  const pasteNotice = (n, back, r) => {
    if (!back) return { tone: 'info', text: `블록 ${n}개를 붙여넣었습니다.` }
    const total = back.external.length
    if (!r.skipped.length) return { tone: 'info', text: `블록 ${n}개를 원래 자리에 되돌렸습니다${total ? ` (연결 ${total}개 복원)` : ''}.` }
    const gone = [...new Set(r.skipped.map((e) => e.other))]
    const names = gone.slice(0, 3).join(', ') + (gone.length > 3 ? ` 외 ${gone.length - 3}개` : '')
    return {
      tone: 'warn',
      text: `연결 ${total}개 중 ${r.restored}개만 복원했습니다. 지워진 블록: ${names}`,
    }
  }
  const paste = (text) => {
    const c = parseClip(text)
    if (!c || !flowRef.current) return false
    let dx
    let dy
    let back = null
    const mine = text === clip.current.text
    if (mine && c.nodes.every((n) => byId.has(n.id))) {
      clip.current.pastes += 1
      dx = dy = 40 * clip.current.pastes // 원본이 아직 있음: 원본 옆에 계단식으로
    } else if (mine && clip.current.cut && clip.current.doc === doc.current) {
      // 같은 워크플로에서 잘라낸 블록이 아직 안 돌아왔으면 원래 자리·원래 id·원래 연결로 (붙여넣기를 되돌린 뒤 다시 붙여도 마찬가지).
      // 돌아온 뒤 또 붙이면 원래 id가 있으므로 위 갈래(원본 옆 사본)로 간다
      if (c.nodes.every((n) => !byId.has(n.id))) back = clip.current.links
      dx = dy = back ? 0 : 40 * ++clip.current.pastes
    } else {
      // 다른 워크플로·다른 탭에서 온 블록: 지금 보이는 화면 가운데로
      const r = flowRef.current.getBoundingClientRect()
      const at = screenToFlowPosition({ x: r.left + r.width / 2, y: r.top + r.height / 3 })
      dx = at.x - NODE_W / 2 - Math.min(...c.nodes.map((n) => n.position.x))
      dy = at.y - Math.min(...c.nodes.map((n) => n.position.y))
    }
    const stamp = Date.now()
    let seq = 0
    const g = instantiate(c, (old) => (back && !byId.has(old) ? old : `n${stamp}_${seq++}`), dx, dy)
    const r = back ? restoreLinks([...edges, ...g.edges], back, g.id, (x) => byId.has(x)) : { edges: [...edges, ...g.edges] }
    setNodes((ns) => [...ns.map((n) => (n.selected ? { ...n, selected: false } : n)), ...g.nodes])
    setEdges(r.edges)
    setNotice(pasteNotice(g.nodes.length, back, r))
    return true
  }

  // 노드·연결선이 부르는 동작: 객체는 그대로 두고 함수만 매번 바꿔 끼워, 노드 전체가 다시 그려지지 않게 한다
  const actions = useRef({}).current
  Object.assign(actions, {
    openPicker: (el, at) => setPicker({ anchor: anchorOf(el), at, title: at.edge ? '이 사이에 블록 추가' : '다음 블록 추가' }),
    test: (id) => testNode(byId.get(id)),
    duplicate,
    remove: (id) => deleteElements({ nodes: [{ id }] }),
    undo,
    redo,
    copyNodes,
    paste,
    // 툴바 '복사' 버튼: 시스템 클립보드는 https·localhost에서만 쓸 수 있어 실패해도 앱 안 클립보드로 붙여넣기 가능
    copy: () => { const t = copyNodes(); if (t) navigator.clipboard?.writeText(t).catch(() => {}) },
  })

  // Ctrl+C·Ctrl+X·Ctrl+V: 브라우저 복사/붙여넣기 이벤트를 쓴다 (GB10에 http로 접속해도 동작, 다른 탭에 붙여넣기 가능).
  // 입력칸 안이거나 글자를 끌어서 골라 둔 상태면 브라우저 기본(글자 복사)에 맡긴다
  useEffect(() => {
    const typing = (e) => e.target.closest?.('input, textarea, select, [contenteditable="true"]')
    const onCopy = (e) => {
      if (typing(e) || getSelection()?.toString()) return
      const text = actions.copyNodes(e.type === 'cut')
      if (!text) return
      e.clipboardData.setData('text/plain', text)
      e.preventDefault()
    }
    const onPaste = (e) => {
      if (!typing(e) && actions.paste(e.clipboardData.getData('text/plain'))) e.preventDefault()
    }
    addEventListener('copy', onCopy)
    addEventListener('cut', onCopy)
    addEventListener('paste', onPaste)
    return () => {
      removeEventListener('copy', onCopy)
      removeEventListener('cut', onCopy)
      removeEventListener('paste', onPaste)
    }
  }, [actions])

  // Ctrl+Z 되돌리기, Ctrl+Shift+Z·Ctrl+Y 다시 하기. 한글 입력 상태에서도 되도록 물리 키(code)로 본다.
  // 입력칸에 글자를 쓰는 중에는 브라우저 기본(입력칸 글자 되돌리기)에 맡긴다
  useEffect(() => {
    const onKey = (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.target.closest?.('input, textarea, select, [contenteditable="true"]')) return
      if (e.code !== 'KeyZ' && e.code !== 'KeyY') return
      e.preventDefault()
      if (e.code === 'KeyY' || e.shiftKey) actions.redo()
      else actions.undo()
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [actions])

  // 한 출력에서 여러 단계로 연결하면 병렬 실행 (같은 연결 중복만 막는다)
  const onConnect = (c) => setEdges((es) => addEdge({ ...c, id: `${c.source}-${c.sourceHandle || 'out'}-${c.target}` }, es))

  // 들어오는 연결이 하나뿐인 중간 노드를 지우면 앞뒤를 잇는다. 삭제는 되돌릴 수 있다
  const onNodesDelete = (deleted) => {
    const prev = { nodes, edges }
    const had = new Set(edges.map((e) => e.id))
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
    bridged.current = next.filter((e) => !had.has(e.id)).map((e) => e.id)
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

  const layout = () => {
    setNodes((ns) => arrange(ns, edges))
    fit()
  }

  // 덮어쓰는 동작은 확인 창 대신 되돌리기로 보호
  const replace = (next, nextName, text, snap = null) => {
    doc.current += 1
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
  // 새 문서로 연다: 열려 있던 워크플로 이름을 이어 쓰면 저장할 때 그 워크플로를 덮어씀
  const loadGenerated = (g) => replace({ nodes: arrange(g.nodes.map((n) => ({ ...n, position: { x: 0, y: 0 } })), g.edges), edges: g.edges },
    'AI 시나리오', 'AI가 만든 시나리오를 불러왔습니다. 자세 값을 확인하고 시뮬레이션으로 먼저 검증하세요.')
  const deleteFromServer = (w) => {
    sendLibrary('delete', { name: w.name })
    setNotice({ tone: 'info', text: `${w.name}을(를) GB10에서 삭제했습니다.`, undo: () => sendLibrary('save', { name: w.name, graph: w.graph }) })
  }
  const saveToServer = () => {
    const nm = name.trim() || DEFAULT_NAME
    pendingSave.current = { id: sendLibrary('save', { name: nm, graph: toGraph(nodes, edges) }), snap: snapshot(nodes, edges), name: nm }
  }
  const snap = snapshot(nodes, edges)
  const dirty = savedSnap !== snap

  // 경로 미리보기·동작 점검 (motionPlan.js): 계산용 로봇(URDF 한계 + 팔 끝 순기구학)과 작업 셀로
  useSyncExternalStore(onRobotInfo, () => robotInfo.version) // URDF·작업 셀이 오면 다시 그림
  const { urdf, scene } = robotInfo
  const model = useMemo(() => robotModel(urdf, scene?.tcp), [urdf, scene?.tcp])
  const homeKey = (status.home || []).join()
  const plan = useMemo(() => motionPlan({ nodes, edges }, names, status.home || []), [snap, names.join(), homeKey]) // eslint-disable-line react-hooks/exhaustive-deps
  // 실행 전 점검 (check.js + 동작 점검). 위치는 보지 않으므로 드래그 중에는 다시 계산하지 않는다
  const issues = useMemo(() => [
    ...checkGraph({ nodes, edges }, specs, names.length),
    ...checkMotion(plan, model?.limits, model && { tipAt: model.tipAt, obstacles: scene?.objects }),
  ], [snap, specs, names.length, plan, model, scene]) // eslint-disable-line react-hooks/exhaustive-deps
  const issueMap = useMemo(() => {
    const m = new Map()
    for (const i of issues) m.set(i.node, [...(m.get(i.node) || []), i])
    return m
  }, [issues])
  const errors = issues.filter((i) => i.level === 'error')
  // 문제 있는 블록으로 이동해 선택 (오류 먼저). 트윈 보기면 편집 보기로 바꾼다
  // 편집 보기로 바꿔 그 블록을 선택하고 화면에 맞춤 (실행 전 점검·운영 화면 조치 안내가 씀)
  const focusNode = (id) => {
    setView('edit')
    setNodes((ns) => ns.map((n) => (n.selected === (n.id === id) ? n : { ...n, selected: n.id === id })))
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches
    requestAnimationFrame(() => fitView({ nodes: [{ id }], maxZoom: 1, duration: still ? 0 : 300 }))
  }
  const goToIssue = () => {
    const first = errors[0] || issues[0]
    if (first) focusNode(first.node)
  }
  // 오류가 있으면 실행하지 않고 첫 문제로 데려간다 (실행 도중 멈추는 대신 미리)
  const tryRun = (mode) => {
    if (errors.length) {
      goToIssue()
      setNotice({ tone: 'error', text: `실행 전 점검에서 문제 ${errors.length}건: ${labelOf(errors[0].node)} — ${errors[0].text}` })
      return
    }
    runWorkflow({ ...runGraph(), name: name.trim() || DEFAULT_NAME }, mode) // 이름이 있으면 실행기가 운영 기록에 남김
  }

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
  const viewer = <Viewer large={view !== 'edit'} stale={!connected} ghost={ghost} followCommand={running && !simRun} simRun={simRun} replay={!!episode.playing}
    plan={plan} selectedId={editing?.id} model={model} />

  return (
    <Specs.Provider value={specCtx}>
      <NodeActions.Provider value={actions}>
      <JointNames.Provider value={names}>
      <Robot.Provider value={robotCtx}>
      <Issues.Provider value={issueMap}>
        <div className="app">
          <a className="skip-link" href="#workspace">작업 영역으로 건너뛰기</a>
          <header className="topbar">
            {/* 상태는 이 안에서만 줄바꿈 → 오류 글·단계 이름이 길어져도 실행·정지·비상정지는 늘 오른쪽 위 같은 자리 */}
            <div className="topbar-status">
              <h1 translate="no">Physical AI Workflow</h1>
              <RobotMode connected={connected} />
              <HealthBar connected={connected} everConnected={everConnected}
                executor={specsLive} recorder={!episode.pending} />
              <RunStatus status={status} steps={steps} labelOf={labelOf} />
              <RecChip episode={episode} />
              {status.msg && <span className="topbar-msg error-text" title={status.msg}>{status.msg}</span>}
            </div>
            <div className="actions">
              <button className="sim-btn" onClick={() => tryRun('sim')} disabled={!connected || running || estop}
                title="디지털 트윈에서만 실행합니다. 실제 로봇·장비는 움직이지 않습니다">
                <Icon name="sim" />시뮬레이션
              </button>
              <button className="start-btn" onClick={() => tryRun('real')} disabled={!connected || running || estop}
                title={!connected ? '실행기와 연결되지 않음' : estop ? '비상정지 상태: 해제한 뒤 실행' : running ? '실행 중' : '실제 로봇으로 실행'}>
                <Icon name="play" />실행
              </button>
              <button className="danger" onClick={stopWorkflow} disabled={!connected} aria-keyshortcuts="Escape"
                title="정지 (Esc). 진행 중인 동작을 취소하며, 비상정지(E-stop)를 대신하지 않습니다">
                <Icon name="stop" />정지
              </button>
            </div>
            <button className="estop-btn" onClick={() => setEstop(true)} disabled={!connected || estop} aria-pressed={estop}
              title={!connected ? '실행기와 연결되지 않음: 하드웨어 비상정지를 사용하세요' : '모든 동작을 즉시 멈추고 해제할 때까지 잠급니다. 하드웨어 비상정지(E-stop)를 대신하지 않습니다'}>
              <Icon name="estop" size={20} />{estop ? '비상정지 중' : '비상정지'}
            </button>
          </header>
          {/* 비상정지 띠만 맨 위에 고정 (안전 잠금은 스크롤해도 보여야 함). 일반 알림은 편집 영역 안, 캔버스 위에 자리를 차지해 캔버스를 가리지 않는다 */}
          <div className="alerts">
            <EstopBanner on={estop} connected={connected} onRelease={() => setEstop(false)} />
          </div>
          <ConnectionBanner connected={connected} everConnected={everConnected} url={url} />
          <main>
            <section className="workspace" id="workspace" tabIndex={-1} aria-label="워크플로">
              <div className="docbar">
                {/* 운영 보기는 실행·정지만: 이름은 읽기 전용, 편집·저장 도구는 편집/트윈 보기에 */}
                {view === 'ops' ? <span className="doc-name doc-name-text" title={name}>{name}</span> : (
                  <input className="doc-name" name="workflowName" autoComplete="off" value={name} onChange={(e) => setName(e.target.value)}
                    onBlur={() => !name.trim() && setName(DEFAULT_NAME)} aria-label="워크플로 이름" spellCheck={false} />
                )}
                <span className={`doc-state${dirty ? ' dirty' : ''}`} title={dirty ? 'GB10에 저장되지 않은 변경이 있습니다' : 'GB10에 저장된 내용과 같습니다'}>
                  {dirty ? '저장 안 됨' : '저장됨'}
                </span>
                <span className="doc-meta">{steps.length}단계</span>
                {issues.length > 0 && view !== 'ops' && (
                  <button className={`doc-issues ${errors.length ? 'error' : 'warn'}`} onClick={goToIssue}
                    title={errors.length ? '실행 전 점검: 고쳐야 실행할 수 있습니다. 누르면 첫 문제로 이동' : '실행되지 않는 블록이 있습니다. 누르면 이동'}>
                    <Icon name="alert" />{errors.length ? `문제 ${errors.length}건` : `주의 ${issues.length}건`}
                  </button>
                )}
                <span className="spacer" />
                <Segmented className="view-switch" label="보기" value={view} onChange={setView}
                  options={[['edit', '편집'], ['twin', '트윈'], ['ops', '운영', '현장 작업자용: 작업 상태·진행·오늘 운영 현황']]} />
                {view === 'edit' && (
                  <button className="ghost" onClick={layout} title="실행 순서대로 자동 배치 (분기·병렬은 옆으로)">
                    <Icon name="layout" /><span className="label">정렬</span>
                  </button>
                )}
                {view !== 'ops' && (
                  <>
                    <button className="ghost" onClick={newWorkflow} title="빈 워크플로로 시작 (되돌리기 가능)">
                      <Icon name="file" /><span className="label">새로 만들기</span>
                    </button>
                    <AIBuilder gen={gen} connected={connected} onLoad={loadGenerated} />
                    <LibraryMenu items={library.items || []} connected={connected && !library.pending} onOpen={openFromServer}
                      onDelete={deleteFromServer} onImportFile={() => fileRef.current.click()} onExportFile={exportJson} />
                    <button className="ghost save-btn" onClick={saveToServer} disabled={!connected}
                      title="GB10에 저장 (같은 이름이면 덮어씀). 저장하면 다른 화면에서도 열 수 있습니다">
                      <Icon name="save" /><span className="label">저장</span>
                    </button>
                  </>
                )}
                <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={importJson} />
              </div>
              <Notice notice={notice} onClose={closeNotice} />
              {view === 'ops' ? (
                <OpsView status={status} steps={steps} labelOf={labelOf} runs={runs} connected={connected} viewer={viewer}
                  name={name.trim() || DEFAULT_NAME} hasLoop={nodes.some((n) => n.type === 'loop')}
                  onFix={(id, todo) => { focusNode(id); setNotice({ tone: 'warn', text: todo }) }} // 편집으로 가도 할 일은 알림으로 남김
                  onHome={() => moveHome()} onRerun={() => tryRun('sim')} />
              ) : view === 'twin' ? (
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
                    edgeTypes={EDGE_TYPES}
                    defaultEdgeOptions={EDGE_DEFAULTS}
                    connectOnClick={false}
                    colorMode="system"
                    fitView
                    fitViewOptions={FIT}
                    minZoom={0.2}
                  >
                    <Panel position="top-left" className="add-panel">
                      <button className="add-block" aria-haspopup="dialog" aria-expanded={!!picker && !picker.at}
                        onClick={(e) => setPicker({ anchor: anchorOf(e.currentTarget), at: null, title: editing ? '선택한 단계 뒤에 추가' : '블록 추가' })}>
                        <Icon name="plus" />블록 추가
                      </button>
                      <span className="add-sep" aria-hidden="true" />
                      <button className="icon-btn" onClick={undo} disabled={!canUndo} aria-label="되돌리기" title="되돌리기 (Ctrl+Z)" aria-keyshortcuts="Control+Z">
                        <Icon name="undo" />
                      </button>
                      <button className="icon-btn" onClick={redo} disabled={!canRedo} aria-label="다시 하기" title="다시 하기 (Ctrl+Shift+Z)" aria-keyshortcuts="Control+Shift+Z Control+Y">
                        <Icon name="redo" />
                      </button>
                      <button className="icon-btn" onClick={() => paste(clip.current.text)} disabled={!clipCount} aria-label="붙여넣기" aria-keyshortcuts="Control+V"
                        title={clipCount ? `붙여넣기: 복사한 블록 ${clipCount}개 (Ctrl+V)` : '붙여넣기 (먼저 블록을 복사하세요)'}>
                        <Icon name="paste" />
                      </button>
                      <Hint label="블록 추가·연결 방법">
                        노드 아래의 + 를 누르면 그 다음에, 연결선 가운데의 + 를 누르면 그 사이에 블록을 넣습니다. 점을 끌어 다른 단계에 이으면 연결되고,
                        한 출력에 여러 단계를 이으면 동시에 실행됩니다(합류 노드에서 다시 모임). 선택한 노드 위 버튼으로 시험·복제·삭제하고, Delete 키로도 지웁니다.
                        Ctrl+C·Ctrl+X·Ctrl+V로 복사·잘라내기·붙여넣기(다른 워크플로·다른 탭에도), 잘못 바꿨으면 Ctrl+Z(되돌리기), Ctrl+Shift+Z(다시 하기).
                      </Hint>
                    </Panel>
                    {editing && (
                      <Panel position="top-right" className="inspector-panel">
                        <Inspector key={editing.id} node={editing} onClose={deselect}
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
              {/* 편집 보기: 3D / 트윈 보기: 3D가 가운데 크게 → 이 칸에는 실제 카메라 (트윈과 실물을 나란히) */}
              {view === 'edit' ? viewer : (
                <section className="twin-camera" aria-label="카메라 실시간 화면">
                  <CameraPanel id="twin-camera-view" connected={connected} defaultTopic={status.camera || ''} value={camView} onChange={setCamView} bare />
                </section>
              )}
              {/* 조그·녹화·기록·토픽은 엔지니어 도구라 운영 보기에서는 숨김 (편집/트윈 보기에 그대로) */}
              {view !== 'ops' && <Jog names={names} home={status.home} disabled={!connected || estop || (running && status.node !== 'jog')} />}
              {view !== 'ops' && <Tabs tabs={[
                { id: 'rec', label: <>녹화{episode.recording && <span className="tab-dot" aria-label="녹화 중" />}</>, content: <Episodes episode={episode} connected={connected} notify={setNotice} /> },
                { id: 'camera', label: '카메라', lazy: true, content: <CameraPanel connected={connected} defaultTopic={status.camera || ''} value={camView} onChange={setCamView} /> },
                { id: 'log', label: '기록', content: <Logs entries={log.entries} labelOf={labelOf} /> },
                { id: 'topics', label: '토픽', content: <Topics connected={connected} /> },
              ]} />}
            </aside>
          </main>
          {picker && <BlockPicker anchor={picker.anchor} title={picker.title} live={specsLive} onClose={closePicker} onPick={(type) => add(type, picker.at)} />}
        </div>
      </Issues.Provider>
      </Robot.Provider>
      </JointNames.Provider>
      </NodeActions.Provider>
    </Specs.Provider>
  )
}
