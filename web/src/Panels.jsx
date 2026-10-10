// 오른쪽 패널: 조그(관절 단위 수동 이동), 에피소드 녹화, 토픽 모니터(아무 ROS 토픽이나 실시간 보기)
import { useEffect, useRef, useState } from 'react'
import { Hint } from './Hint'
import { Icon } from './icons'
import { currentDeg, moveTo, ros, sendEpisode, topic } from './ros'

const RESULT = {
  success: '성공', fail: '실패', stopped: '정지', error: '오류', done: '종료', interrupted: '중단',
  shutdown: '시스템 종료', failed_to_start: '시작 실패', recorder_died: '녹화기 오류',
}

export const useTick = (ms, active = true) => {
  const [, tick] = useState(0)
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => tick((x) => x + 1), ms)
    return () => clearInterval(t)
  }, [ms, active])
}

export const elapsed = (iso) => {
  const s = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000)) || 0
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export function Jog({ names, disabled }) {
  const [step, setStep] = useState(5)
  useTick(100) // 표시값 10Hz 갱신
  const deg = currentDeg(names)
  const jog = (i, dir) => moveTo(deg.map((v, j) => (j === i ? v + dir * step : v)), 0.3)
  return (
    <section className="panel" aria-labelledby="jog-title">
      <div className="panel-head">
        <h2 id="jog-title">조그</h2>
        <div className="segmented" role="radiogroup" aria-label="조그 간격">
          {[1, 5, 10, 30].map((s) => (
            <button key={s} role="radio" aria-checked={step === s} onClick={() => setStep(s)}>{s}°</button>
          ))}
        </div>
      </div>
      {!names.length && <p className="muted">실행기 연결을 기다리는 중…</p>}
      <div className="jog-list">
        {names.map((n, i) => (
          <div className="jog-row" key={n}>
            <span className="jog-name" title={n} translate="no">{n}</span>
            <button className="icon-btn" disabled={disabled} onClick={() => jog(i, -1)} aria-label={`${n} ${step}° 감소`}>
              <Icon name="minus" />
            </button>
            <output aria-label={`${n} 현재 각도`}>{deg[i].toFixed(1)}°</output>
            <button className="icon-btn" disabled={disabled} onClick={() => jog(i, 1)} aria-label={`${n} ${step}° 증가`}>
              <Icon name="plus" />
            </button>
          </div>
        ))}
      </div>
    </section>
  )
}

// WAI-ARIA 탭: 좌우 화살표로 이동
export function Tabs({ tabs }) {
  const [cur, setCur] = useState(0)
  const refs = useRef([])
  const key = (e) => {
    const d = { ArrowRight: 1, ArrowLeft: -1 }[e.key]
    if (!d) return
    const n = (cur + d + tabs.length) % tabs.length
    setCur(n)
    refs.current[n]?.focus()
  }
  return (
    <section className="panel tabs">
      <div className="tablist" role="tablist" onKeyDown={key}>
        {tabs.map((t, i) => (
          <button key={t.id} id={`tab-${t.id}`} ref={(el) => { refs.current[i] = el }} role="tab"
            aria-selected={cur === i} aria-controls={`panel-${t.id}`} tabIndex={cur === i ? 0 : -1} onClick={() => setCur(i)}>
            {t.label}
          </button>
        ))}
      </div>
      {tabs.map((t, i) => (
        <div key={t.id} id={`panel-${t.id}`} role="tabpanel" aria-labelledby={`tab-${t.id}`} hidden={cur !== i}>
          {t.content}
        </div>
      ))}
    </section>
  )
}

// 수동 녹화(조그·텔레옵 시연)용. 워크플로 안에서는 '에피소드 시작/종료' 노드를 쓴다
export function Episodes({ episode, connected }) {
  const [task, setTask] = useState('')
  const rec = episode.recording
  useTick(500, rec)
  const start = (e) => {
    e.preventDefault()
    sendEpisode('start', { task: task.trim(), meta: { source: 'manual' } })
  }
  const stop = (result) => sendEpisode('stop', { result })
  return (
    <div className="episodes">
      <h2 className="sr-only">에피소드 녹화</h2>
      {/* 상태가 바뀔 때만 읽히도록 타이머와 분리 */}
      <p className="sr-only" role="status">{rec ? `녹화 중: ${episode.current?.task || '작업 설명 없음'}` : ''}</p>
      {rec ? (
        <div className="rec-live">
          <div className="rec-time"><span className="rec-dot" aria-hidden="true" />녹화 중 <b>{elapsed(episode.current?.started)}</b></div>
          <p className="rec-task">{episode.current?.task || '작업 설명 없음'}</p>
          <div className="row">
            <button className="ok-btn" onClick={() => stop('success')}><Icon name="check" />성공으로 종료</button>
            <button onClick={() => stop('fail')}><Icon name="close" />실패로 종료</button>
          </div>
        </div>
      ) : (
        <form className="rec-form" onSubmit={start}>
          <div className="field">
            <div className="field-head">
              <label htmlFor="rec-task" className="field-label">작업 설명 (학습 지시문)</label>
              <Hint label="녹화 방법">
                조그나 텔레옵으로 시연한 뒤 성공 또는 실패로 종료합니다. 작업 설명이 없는 에피소드는 학습 데이터 변환에서 빠집니다.
              </Hint>
            </div>
            <input id="rec-task" name="task" autoComplete="off" value={task} onChange={(e) => setTask(e.target.value)} placeholder="예: 빨간 블록을 상자에 넣기…" />
          </div>
          <button type="submit" className="rec-btn" disabled={!connected}><Icon name="record" />녹화 시작</button>
        </form>
      )}
      {episode.error && <p className="error-text" role="alert">{episode.error}</p>}
      <h3 className="list-title">최근 에피소드 <span className="muted">{episode.episodes?.length || 0}개</span></h3>
      {episode.episodes?.length ? (
        <div className="table-wrap">
          <table className="episode-table">
            <thead>
              <tr><th scope="col">작업</th><th scope="col">결과</th><th scope="col" className="num">길이</th><th scope="col" className="num">시각</th></tr>
            </thead>
            <tbody>
              {episode.episodes.map((e) => (
                <tr key={e.name} title={e.name}>
                  <td className="ep-task">{e.task || <span className="muted">작업 설명 없음</span>}</td>
                  <td><span className={`result ${e.result}`}>{RESULT[e.result] ?? e.result ?? '진행 중'}</span></td>
                  <td className="num">{e.duration != null ? `${e.duration.toFixed(1)}s` : ''}</td>
                  <td className="num">{e.started ? new Date(e.started).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false }) : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted empty">아직 녹화한 에피소드가 없습니다.</p>
      )}
    </div>
  )
}

export function Topics({ connected }) {
  const [list, setList] = useState([])
  const [sel, setSel] = useState('')
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')

  const refresh = () => ros.getTopics(
    (r) => { setErr(''); setList(r.topics.map((t, i) => [t, r.types[i]]).sort()) },
    (e) => setErr(`토픽 목록을 가져오지 못했습니다: ${e}`))
  useEffect(() => { if (connected) refresh() }, [connected])

  useEffect(() => {
    const type = list.find(([t]) => t === sel)?.[1]
    setMsg('')
    if (!type) return
    const t = topic(sel, type, { throttle_rate: 200, queue_length: 1 })
    // ponytail: 이미지/포인트클라우드 같은 큰 메시지는 잘라서 표시만 함
    const cb = (m) => setMsg(JSON.stringify(m, null, 1).slice(0, 3000))
    t.subscribe(cb)
    return () => t.unsubscribe(cb)
  }, [sel, list])

  return (
    <div className="topics">
      <h2 className="sr-only">토픽 모니터</h2>
      <div className="row">
        <select value={sel} onChange={(e) => setSel(e.target.value)} aria-label="토픽 선택" name="topic" translate="no">
          <option value="">토픽 선택</option>
          {list.map(([t, type]) => <option key={t} value={t}>{t} ({type})</option>)}
        </select>
        <button className="icon-btn" onClick={refresh} disabled={!connected} aria-label="토픽 목록 새로고침" title="토픽 목록 새로고침">
          <Icon name="refresh" />
        </button>
      </div>
      {err && <p className="error-text" role="alert">{err}</p>}
      <pre className={msg ? 'code' : 'code empty'} aria-live="off" translate="no">
        {msg || (sel ? '메시지를 기다리는 중…' : '토픽을 고르면 최신 메시지가 표시됩니다.')}
      </pre>
    </div>
  )
}
