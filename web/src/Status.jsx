// 상단 바의 상태 표시. 전부 기존 ROS 토픽에서 계산하며 새 API는 없다.
import { useEffect, useMemo, useRef, useState } from 'react'
import { Hint } from './Hint'
import { Icon } from './icons'
import { useTick } from './Panels'
import { latest, ros } from './ros'

export const STATE_LABEL = { idle: '대기', running: '실행 중', done: '완료', error: '오류', stopped: '정지됨' }

// 구성요소별 상태: 운영 중 어디가 멈췄는지, 시연 때 전부 정상인지 한눈에
export function HealthBar({ connected, everConnected, executor, recorder }) {
  const [hz, setHz] = useState(0)
  const last = useRef(latest.count)
  useEffect(() => {
    const t = setInterval(() => { setHz(latest.count - last.current); last.current = latest.count }, 1000)
    return () => clearInterval(t)
  }, [])
  const live = connected && performance.now() - latest.stamp < 1500
  const of = (ok) => (!connected ? 'off' : ok ? 'ok' : 'wait')
  const items = [
    { name: '연결', state: connected ? 'ok' : everConnected ? 'bad' : 'wait',
      detail: connected ? 'rosbridge 연결됨' : everConnected ? '끊김, 재연결 중' : '연결 중' },
    { name: '실행기', state: of(executor), detail: executor ? '노드 타입 수신됨' : '응답 없음' },
    { name: '녹화기', state: of(recorder), detail: recorder ? '녹화 준비됨' : '응답 없음' },
    { name: '관절', state: of(live), detail: live ? `${hz}Hz 수신 중` : '수신 없음', value: live ? `${hz}Hz` : null },
  ]
  return (
    <ul className="health" aria-label="시스템 상태">
      {items.map((it) => (
        <li key={it.name} className={`health-item ${it.state}`} title={`${it.name}: ${it.detail}`}>
          <span className="dot" aria-hidden="true" />
          <span className="health-name">{it.name}</span>
          {it.value && <span className="health-value">{it.value}</span>}
          <span className="sr-only">{it.detail}</span>
        </li>
      ))}
    </ul>
  )
}

// 실행 상태 + 단계 진행 + 사이클 타임. 경과 시간은 스크린리더 알림 영역 밖에 둔다 (매초 읽히지 않도록)
// 실행 중이면 경과 초, 아니면 마지막 실행의 소요 초 (조그는 세지 않음) | null.
// 실행기가 상태에 실어 보낸 elapsed 를 받은 순간부터 이어 센다 → 화면을 언제 열어도 같고, GB10·태블릿 시계 차이와 무관
export function useRunTimer(status) {
  const counting = status.state === 'running' && status.elapsed != null
  const at = useMemo(() => performance.now(), [status]) // 이 상태 메시지를 받은 시각
  useTick(200, counting)
  if (status.elapsed == null) return null
  return counting ? status.elapsed + (performance.now() - at) / 1000 : status.elapsed
}

export function RunStatus({ status, steps, labelOf }) {
  const running = status.state === 'running'
  const t = useRunTimer(status)
  const act = status.active?.length ? status.active : [status.node]
  const idx = Math.max(...act.map((id) => steps.indexOf(id)))
  const seg = (i) => (status.state === 'done' ? 'past' : i < idx ? 'past' : i === idx ? 'now' : '')
  return (
    <div className={`runstat ${status.state}`}>
      <span className="runstat-text" role="status" aria-atomic="true">
        <span className="dot" aria-hidden="true" />
        <b>{STATE_LABEL[status.state] ?? status.state}</b>
        {status.mode === 'sim' && status.state !== 'idle' && <span className="runstat-sim">시뮬레이션</span>}
        {running && act.length > 1 && <span className="runstat-step">병렬 {act.length}개</span>}
        {idx >= 0 && status.state !== 'done' && <span className="runstat-step">{idx + 1}/{steps.length}단계</span>}
        {status.node && status.state !== 'done' && <span className="runstat-node">{labelOf(status.node)}</span>}
      </span>
      {steps.length > 0 && steps.length <= 24 && (
        <span className="runstat-bar" aria-hidden="true">
          {steps.map((s, i) => <i key={s} className={seg(i)} />)}
        </span>
      )}
      {t != null && <span className="runstat-time" title={running ? '경과 시간' : '마지막 사이클 시간'}>{t.toFixed(1)}s</span>}
    </div>
  )
}

// 지금 명령이 실제 로봇으로 가는지 시뮬레이션(모의 팔)으로 가는지. 안전상 항상 보이게 둔다.
// 기존 rosapi 노드 목록으로 판별: 모의 팔 노드가 있으면 시뮬레이션, 없고 관절 상태가 들어오면 실제 로봇
export function RobotMode({ connected }) {
  const [mode, setMode] = useState(null)
  useEffect(() => {
    if (!connected) { setMode(null); return }
    const check = () => ros.getNodes(
      // 트윈 팔(/sim/sim_arm)은 항상 떠 있으므로 루트의 모의 팔(/mock_arm)만 본다
      (ns) => setMode(ns.includes('/mock_arm') ? 'sim'
        : performance.now() - latest.stamp < 1500 ? 'real' : null),
      () => setMode(null))
    check()
    const t = setInterval(check, 10000)
    return () => clearInterval(t)
  }, [connected])
  if (!mode) return null
  return (
    <span className={`mode ${mode}`} title={mode === 'sim' ? '모의 팔로 실행 중입니다. 실제 로봇은 움직이지 않습니다' : '명령이 실제 로봇을 움직입니다'}>
      {mode === 'sim' ? '시뮬레이션' : '실제 로봇'}
    </span>
  )
}

// 트윈 보기의 워크플로 단계 스트립: 실행 위치를 따라가고, 단계를 누르면 그 목표 자세를 고스트로 미리 본다
export function StepStrip({ steps, status, labelOf, selectedId, onSelect }) {
  const act = status.active?.length ? status.active : status.state === 'running' ? [status.node] : []
  const cur = Math.max(-1, ...act.map((id) => steps.indexOf(id)), ['error', 'stopped'].includes(status.state) ? steps.indexOf(status.node) : -1)
  const refs = useRef({})
  useEffect(() => { refs.current[status.node]?.scrollIntoView({ block: 'nearest', inline: 'nearest' }) }, [status.node])
  if (!steps.length) return <p className="steps-empty muted">시작 노드에 연결된 단계가 없습니다. 편집 보기에서 노드를 추가하세요.</p>
  return (
    <ol className="steps" aria-label="워크플로 단계">
      {steps.map((id, i) => {
        const now = act.includes(id) || (i === cur && ['error', 'stopped'].includes(status.state))
        const state = status.state === 'done' ? 'past' : now ? `now ${status.state}` : i < cur ? 'past' : ''
        return (
          <li key={id}>
            <button ref={(el) => { refs.current[id] = el }} className={`step ${state}${selectedId === id ? ' selected' : ''}`}
              aria-current={now ? 'step' : undefined} aria-pressed={selectedId === id} onClick={() => onSelect(id)}>
              <span className="step-no">{i + 1}</span>
              <span className="step-label">{labelOf(id)}</span>
            </button>
          </li>
        )
      })}
    </ol>
  )
}

// 정보/오류 알림. undo가 있으면 '되돌리기' 제공 (확인 창 대신 되돌릴 수 있게)
export function Notice({ notice, onClose }) {
  const ref = useRef()
  useEffect(() => {
    if (!notice) return
    // 페이지가 스크롤되는 좁은 화면에서 알림이 화면 위로 벗어나 있으면 그만큼만 올려서 보이게 (캔버스는 가리지 않고 아래로 밀림)
    const r = ref.current?.getBoundingClientRect()
    if (r && r.top < 0) ref.current.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
    // 되돌리기가 있거나 경고·오류면 읽고 대응할 시간을 더 준다
    const t = setTimeout(onClose, notice.undo || notice.tone === 'warn' || notice.tone === 'error' ? 10000 : 6000)
    return () => clearTimeout(t)
  }, [notice, onClose])
  if (!notice) return null
  return (
    <div ref={ref} className={`notice ${notice.tone || 'info'}`} role={notice.tone === 'error' ? 'alert' : 'status'}>
      <span>{notice.text}</span>
      {notice.undo && <button className="ghost" onClick={() => { notice.undo(); onClose() }}>되돌리기</button>}
      <button className="icon-btn" onClick={onClose} aria-label="알림 닫기"><Icon name="close" /></button>
    </div>
  )
}

// 연결이 끊기면 화면 값이 '지난 값'임을 분명히 한다 (현장에서 오판하지 않도록)
export function ConnectionBanner({ connected, everConnected, url }) {
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    setSlow(false)
    if (connected) return
    const t = setTimeout(() => setSlow(true), 4000)
    return () => clearTimeout(t)
  }, [connected])
  if (connected || (!everConnected && !slow)) return null
  return (
    <div className="banner" role="status">
      <span className="dot" aria-hidden="true" />
      <span>{everConnected ? '연결이 끊겨 다시 연결하는 중입니다' : '실행기에 연결할 수 없습니다'}</span>
      <Hint label="연결 문제 해결 방법">
        {everConnected
          ? '로봇 자세와 실행 상태는 마지막으로 받은 값이라 실제 로봇과 다를 수 있습니다. 연결되면 자동으로 갱신됩니다.'
          : <>{url}에 연결을 시도하고 있습니다. GB10에서 ROS 스택(docker compose)이 실행 중인지 확인하세요. 접속 비밀번호가 바뀌었으면 페이지를 새로고침해 다시 로그인합니다.</>}
      </Hint>
    </div>
  )
}

// 비상정지 잠금 상태: 해제는 두 번 눌러야 한다 (현장 태블릿에서 실수로 풀리지 않게)
export function EstopBanner({ on, connected, onRelease }) {
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => setArmed(false), 4000)
    return () => clearTimeout(t)
  }, [armed])
  useEffect(() => { if (!on) setArmed(false) }, [on])
  if (!on) return null
  return (
    <div className="estop-banner" role="alert">
      <Icon name="estop" size={20} />
      <span><b>비상정지 상태</b> 모든 동작을 멈췄고 실행·조그·홈 이동이 잠겨 있습니다. 로봇 주변의 안전을 확인한 뒤 해제하세요.</span>
      <button className={armed ? 'danger' : ''} disabled={!connected} onClick={() => (armed ? onRelease() : setArmed(true))}>
        {armed ? '한 번 더 눌러 해제' : '해제'}
      </button>
    </div>
  )
}
