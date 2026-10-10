// 오른쪽 패널: 조그(관절 단위 수동 이동) + 토픽 모니터(아무 ROS 토픽이나 실시간 보기)
import { useEffect, useState } from 'react'
import { currentDeg, moveTo, ros, topic } from './ros'

export function Jog({ names, disabled }) {
  const [step, setStep] = useState(5)
  const [, tick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 100) // 표시값 10Hz 갱신
    return () => clearInterval(t)
  }, [])
  const deg = currentDeg(names)
  const jog = (i, dir) => moveTo(deg.map((v, j) => (j === i ? v + dir * step : v)), 0.3)
  return (
    <section className="panel">
      <h3>
        조그
        <select value={step} onChange={(e) => setStep(+e.target.value)} aria-label="조그 간격">
          {[1, 5, 10, 30].map((s) => <option key={s} value={s}>{s}°</option>)}
        </select>
      </h3>
      {!names.length && <p className="muted">실행기 연결 대기 중</p>}
      {names.map((n, i) => (
        <div className="jog-row" key={n}>
          <span>{n}</span>
          <button disabled={disabled} onClick={() => jog(i, -1)} aria-label={`${n} 감소`}>−</button>
          <output>{deg[i].toFixed(1)}°</output>
          <button disabled={disabled} onClick={() => jog(i, 1)} aria-label={`${n} 증가`}>+</button>
        </div>
      ))}
    </section>
  )
}

export function Topics({ connected }) {
  const [list, setList] = useState([])
  const [sel, setSel] = useState('')
  const [msg, setMsg] = useState('')

  const refresh = () => ros.getTopics(
    (r) => setList(r.topics.map((t, i) => [t, r.types[i]]).sort()),
    (e) => setMsg(`토픽 목록 실패: ${e}`))
  useEffect(() => { if (connected) refresh() }, [connected])

  useEffect(() => {
    const type = list.find(([t]) => t === sel)?.[1]
    if (!type) return
    setMsg('')
    const t = topic(sel, type, { throttle_rate: 200, queue_length: 1 })
    // ponytail: 이미지/포인트클라우드 같은 큰 메시지는 잘라서 표시만 함
    const cb = (m) => setMsg(JSON.stringify(m, null, 1).slice(0, 3000))
    t.subscribe(cb)
    return () => t.unsubscribe(cb)
  }, [sel, list])

  return (
    <section className="panel topics">
      <h3>
        토픽 모니터
        <button onClick={refresh} disabled={!connected}>새로고침</button>
      </h3>
      <select value={sel} onChange={(e) => setSel(e.target.value)} aria-label="토픽 선택">
        <option value="">토픽 선택…</option>
        {list.map(([t, type]) => <option key={t} value={t}>{t} ({type})</option>)}
      </select>
      <pre>{msg}</pre>
    </section>
  )
}
