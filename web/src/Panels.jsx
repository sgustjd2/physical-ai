// 오른쪽 패널: 조그(관절 단위 수동 이동), 에피소드 녹화, 토픽 모니터(아무 ROS 토픽이나 실시간 보기)
import { useEffect, useRef, useState } from 'react'
import { CameraView } from './Camera'
import { Hint } from './Hint'
import { Icon } from './icons'
import { currentDeg, moveHome, moveTo, ros, sendEpisode, topic } from './ros'
import { Segmented } from './Segmented'

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

export function Jog({ names, home, disabled }) {
  const [step, setStep] = useState(5)
  useTick(100) // 표시값 10Hz 갱신
  const deg = currentDeg(names)
  const jog = (i, dir) => moveTo(deg.map((v, j) => (j === i ? v + dir * step : v)), 0.3)
  return (
    <section className="panel" aria-labelledby="jog-title" aria-describedby="jog-note">
      <div className="panel-head">
        <h2 id="jog-title">조그</h2>
        <button className="home-btn" onClick={() => moveHome()} disabled={disabled || !names.length}
          title={`실제 로봇을 홈 자세로 이동 (${(home || []).join(', ')}°, 로봇 프로파일의 home)`}>
          <Icon name="home" />홈으로
        </button>
        <Segmented label="조그 간격" options={[1, 5, 10, 30].map((s) => [s, `${s}°`])} value={step} onChange={setStep} />
      </div>
      <p className="panel-note" id="jog-note">로봇을 바로 움직입니다 (시뮬레이션 아님)</p>
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
          {t.lazy && cur !== i ? null : t.content /* lazy: 보일 때만 그림 (카메라는 숨어 있을 때 영상을 받지 않게) */}
        </div>
      ))}
    </section>
  )
}

const REPLAY = '/replay'
const ANSWER = { yes: '예', no: '아니오' }
const CONF = { high: '확신 높음', medium: '확신 보통', low: '확신 낮음' }
const timeOf = (iso) => (iso ? new Date(iso).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false }) : '')

// 녹화한 에피소드 보기: 재생(3D + 카메라), 녹화 중 AI 판단, 결과 고치기, 지우기(휴지통, 되돌리기 가능)
function EpisodeDetail({ e, episode, connected, notify, onClose }) {
  const playing = episode.playing?.name === e.name
  const [since, setSince] = useState(0)
  useEffect(() => { if (playing) setSince(Date.now()) }, [playing])
  useTick(250, playing)
  const cam = (e.topics || []).find((t) => /image|camera/.test(t) && !/camera_info/.test(t))
  const camType = cam?.endsWith('compressed') ? 'sensor_msgs/msg/CompressedImage' : 'sensor_msgs/msg/Image'
  const done = e.result && e.result !== 'interrupted'
  const head = useRef()
  useEffect(() => { head.current?.scrollIntoView({ block: 'nearest' }); head.current?.focus({ preventScroll: true }) }, [])
  const remove = () => {
    sendEpisode('delete', { name: e.name })
    notify({ tone: 'info', text: `'${e.task || e.name}' 에피소드를 휴지통으로 옮겼습니다.`, undo: () => sendEpisode('restore', { name: e.name }) })
    onClose()
  }
  return (
    <section className="ep-detail" aria-label="에피소드 보기">
      <div className="ep-detail-head">
        <h3 className="ep-detail-title" ref={head} tabIndex={-1}>{e.task || '작업 설명 없음'}</h3>
        <span className={`result ${e.result}`}>{RESULT[e.result] ?? e.result ?? '진행 중'}</span>
        <button className="icon-btn" onClick={onClose} aria-label="에피소드 보기 닫기"><Icon name="close" /></button>
      </div>
      <p className="ep-meta muted">
        {timeOf(e.started)}{e.duration != null ? ` · ${e.duration.toFixed(1)}s` : ''} · 카메라 {cam ? <span translate="no">{cam}</span> : '녹화 안 함'}
      </p>
      {playing ? (
        <div className="ep-play">
          <progress max={e.duration || 1} value={Math.min((Date.now() - since) / 1000, e.duration || 1)} aria-label="재생 위치" />
          <button onClick={() => sendEpisode('stop_play', {})}><Icon name="stop" />정지</button>
        </div>
      ) : (
        <button className="ep-play-btn" onClick={() => sendEpisode('play', { name: e.name })} disabled={!connected || episode.recording || !done}
          title={episode.recording ? '녹화 중에는 재생할 수 없습니다' : '3D와 카메라로 녹화를 다시 봅니다 (실제 로봇은 움직이지 않음)'}>
          <Icon name="play" />다시 보기
        </button>
      )}
      {playing && cam && <CameraView topic={REPLAY + cam} list={[{ name: REPLAY + cam, type: camType }]} compact />}
      {!!e.vision?.length && (
        <div className="ep-vision">
          <span className="field-label">녹화 중 AI 판단 {e.vision.length}건</span>
          <ul>
            {e.vision.map((v, i) => (
              <li key={i}>
                <span className="num">{v.t != null ? `${v.t.toFixed(1)}s` : ''}</span>
                <span>{v.question} → <b>{ANSWER[v.answer] ?? v.answer}</b> ({CONF[v.confidence] ?? v.confidence}){v.reason ? ` — ${v.reason}` : ''}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="ep-actions">
        <span className="field-label">학습 데이터</span>
        <Segmented label="결과 고치기" options={['success', 'fail'].map((r) => [r, RESULT[r]])} value={e.result} disabled={!connected || !done}
          onChange={(r) => e.result !== r && sendEpisode('label', { name: e.name, result: r })} />
        <span className="spacer" />
        <button className="ghost danger-text" onClick={remove} disabled={!connected || !done}><Icon name="trash" />지우기</button>
      </div>
    </section>
  )
}

// 수동 녹화(조그·텔레옵 시연)용. 워크플로 안에서는 '에피소드 시작/종료' 노드를 쓴다
export function Episodes({ episode, connected, notify }) {
  const [task, setTask] = useState('')
  const [sel, setSel] = useState(null)
  const selected = episode.episodes?.find((e) => e.name === sel)
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
      {selected && <EpisodeDetail key={selected.name} e={selected} episode={episode} connected={connected} notify={notify} onClose={() => setSel(null)} />}
      <h3 className="list-title">
        최근 에피소드 <span className="muted">{episode.episodes?.length || 0}개</span>
        {/* 학습 데이터 준비 현황 (변환 기본값은 성공 에피소드만 사용) */}
        {['success', 'fail'].map((r) => {
          const n = (episode.episodes || []).filter((e) => e.result === r).length
          return n ? <span key={r} className={`result ${r}`}>{RESULT[r]} {n}</span> : null
        })}
      </h3>
      {episode.episodes?.length ? (
        <div className="table-wrap">
          <table className="episode-table">
            <thead>
              <tr><th scope="col">작업</th><th scope="col">결과</th><th scope="col" className="num">길이</th><th scope="col" className="num">시각</th></tr>
            </thead>
            <tbody>
              {episode.episodes.map((e) => (
                <tr key={e.name} title={e.name} className={e.name === sel ? 'selected' : undefined}>
                  <td className="ep-task">
                    <button className="ep-open" onClick={() => setSel(e.name === sel ? null : e.name)} aria-expanded={e.name === sel}
                      aria-label={`${e.task || '작업 설명 없음'} 에피소드 보기`}>
                      {e.task || <span className="muted">작업 설명 없음</span>}
                      {!!e.vision?.length && <span className="ep-ai" title={`AI 판단 ${e.vision.length}건`}>AI</span>}
                    </button>
                  </td>
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

const clock = new Intl.DateTimeFormat('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })

// 실행 기록: 실행 시작·종료, AI 판단과 근거 (최신이 위)
export function Logs({ entries, labelOf }) {
  if (!entries?.length) return <p className="muted empty">아직 실행 기록이 없습니다. 워크플로를 실행하거나 시뮬레이션하면 여기에 남습니다.</p>
  return (
    <ol className="log-list">
      {[...entries].reverse().map((e, i) => (
        <li key={entries.length - i} className={/^오류|확신하지 못함/.test(e.text) ? 'error-text' : e.text.startsWith('AI 판단') ? 'log-ai' : ''}>
          <time dateTime={e.time}>{clock.format(new Date(e.time))}</time>
          <span className="log-text">{e.node && labelOf(e.node) ? <b>{labelOf(e.node)} </b> : null}{e.text}</span>
        </li>
      ))}
    </ol>
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
