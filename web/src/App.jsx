import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { addEdge, Background, Controls, MarkerType, Panel, ReactFlow, useEdgesState, useNodesState } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import './app.css'
import { ros, runWorkflow, statusTopic, stopWorkflow, url } from './ros'
import { JointNames, nodeTypes, SPECS } from './nodes'
import { Jog, Topics } from './Panels'
import Viewer from './Viewer'

const STATE_LABEL = { idle: '대기', running: '실행 중', done: '완료', error: '오류', stopped: '정지됨' }

const move = (id, x, y, joints) => ({ id, type: 'move_j', position: { x, y }, data: { joints, duration: 2 } })
const DEFAULT = {
  nodes: [
    { id: 'n0', type: 'start', position: { x: 0, y: 40 }, data: {} },
    move('n1', 140, 0, [0, 0, 0, 0, 0, 0]),
    move('n2', 420, 0, [40, 35, 70, 0, 60, 0]),
    { id: 'n3', type: 'wait', position: { x: 700, y: 40 }, data: { sec: 1 } },
    move('n4', 900, 0, [-40, 35, 70, 0, 60, 0]),
    move('n5', 1180, 0, [0, 0, 0, 0, 0, 0]),
  ],
}
DEFAULT.edges = DEFAULT.nodes.slice(1).map((n, i) => ({ id: `e${i}`, source: DEFAULT.nodes[i].id, target: n.id }))

const load = () => {
  try { return JSON.parse(localStorage.getItem('workflow')) || DEFAULT } catch { return DEFAULT }
}

function App() {
  const saved = useState(load)[0]
  const [nodes, setNodes, onNodesChange] = useNodesState(saved.nodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState(saved.edges)
  const [connected, setConnected] = useState(ros.isConnected)
  const [status, setStatus] = useState({ state: 'idle', joints: [] })

  useEffect(() => {
    const on = () => setConnected(true)
    const off = () => setConnected(false)
    ros.on('connection', on)
    ros.on('close', off)
    const cb = (m) => setStatus(JSON.parse(m.data))
    statusTopic.subscribe(cb)
    return () => { ros.off('connection', on); ros.off('close', off); statusTopic.unsubscribe(cb) }
  }, [])

  useEffect(() => {
    try { localStorage.setItem('workflow', JSON.stringify({ nodes, edges })) } catch { /* 저장 불가 환경 */ }
  }, [nodes, edges])

  const running = status.state === 'running'
  const add = (type) => setNodes((ns) => [...ns, {
    id: `n${Date.now()}`, type, position: { x: 80 + ns.length * 30, y: 260 + ns.length * 20 },
    data: structuredClone(SPECS[type].defaults),
  }])
  // 노드당 나가는 엣지는 하나 (분기 노드가 생기기 전까지 실행 순서를 모호하지 않게)
  const onConnect = (c) => setEdges((es) => addEdge(c, es.filter((e) => e.source !== c.source)))
  const run = () => runWorkflow({
    nodes: nodes.map(({ id, type, data }) => ({ id, type, data })),
    edges: edges.map(({ source, target }) => ({ source, target })),
  })

  const exportJson = () => {
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([JSON.stringify({ nodes, edges }, null, 2)], { type: 'application/json' }))
    a.download = 'workflow.json'
    a.click()
    URL.revokeObjectURL(a.href)
  }
  const importJson = async (e) => {
    const f = e.target.files[0]
    e.target.value = ''
    if (!f) return
    try {
      const g = JSON.parse(await f.text())
      if (!Array.isArray(g.nodes) || !Array.isArray(g.edges)) throw new Error('nodes/edges 배열이 없음')
      setNodes(g.nodes)
      setEdges(g.edges)
    } catch (err) {
      alert(`불러오기 실패: ${err.message}`)
    }
  }

  return (
    <JointNames.Provider value={status.joints || []}>
      <div className="app">
        <header>
          <b>Physical AI Workflow</b>
          <span className={connected ? 'ok' : 'bad'} title={url}>{connected ? '● 브리지 연결됨' : '○ 브리지 끊김'}</span>
          <span className={`state ${status.state}`}>
            {STATE_LABEL[status.state] ?? status.state}{status.msg ? ` — ${status.msg}` : ''}
          </span>
          <span className="spacer" />
          <button className="primary" onClick={run} disabled={!connected || running}>▶ 실행</button>
          <button className="danger" onClick={stopWorkflow} disabled={!connected}>■ 정지</button>
          <button onClick={exportJson}>내보내기</button>
          <label className="btn">불러오기<input type="file" accept=".json,application/json" hidden onChange={importJson} /></label>
        </header>
        <main>
          <div className="flow">
            <ReactFlow
              nodes={nodes.map((n) => (n.id === status.node ? { ...n, className: `active ${status.state}` } : n))}
              edges={edges}
              nodeTypes={nodeTypes}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              defaultEdgeOptions={{ markerEnd: { type: MarkerType.ArrowClosed } }}
              colorMode="dark"
              fitView
            >
              <Panel position="top-left" className="palette">
                {Object.entries(SPECS).filter(([k]) => k !== 'start').map(([k, s]) => (
                  <button key={k} onClick={() => add(k)}>+ {s.label}</button>
                ))}
              </Panel>
              <Background />
              <Controls />
            </ReactFlow>
          </div>
          <aside>
            <Viewer />
            <Jog names={status.joints || []} disabled={!connected || (running && status.node !== 'jog')} />
            <Topics connected={connected} />
          </aside>
        </main>
      </div>
    </JointNames.Provider>
  )
}

createRoot(document.getElementById('root')).render(<StrictMode><App /></StrictMode>)
