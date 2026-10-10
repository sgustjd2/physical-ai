// 상단 바의 상태 표시. 전부 기존 ROS 토픽에서 계산하며 새 API는 없다.
import { useEffect, useRef, useState } from 'react'
import { Hint } from './Hint'
import { Icon } from './icons'
import { useTick } from './Panels'
import { latest } from './ros'

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
export function RunStatus({ status, steps, labelOf }) {
  const start = useRef(null)
  const prev = useRef(status.state)
  const [last, setLast] = useState(null)
  const running = status.state === 'running'
  useEffect(() => {
    if (running && prev.current !== 'running') start.current = status.node === 'jog' ? null : performance.now()
    if (!running && prev.current === 'running' && start.current) {
      setLast((performance.now() - start.current) / 1000)
      start.current = null
    }
    prev.current = status.state
  }, [status.state, status.node, running])
  useTick(200, running)

  const idx = steps.indexOf(status.node)
  const t = running && start.current ? (performance.now() - start.current) / 1000 : last
  const seg = (i) => (status.state === 'done' ? 'past' : i < idx ? 'past' : i === idx ? 'now' : '')
  return (
    <div className={`runstat ${status.state}`}>
      <span className="runstat-text" role="status" aria-atomic="true">
        <span className="dot" aria-hidden="true" />
        <b>{STATE_LABEL[status.state] ?? status.state}</b>
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

// 정보/오류 알림. undo가 있으면 '되돌리기' 제공 (확인 창 대신 되돌릴 수 있게)
export function Notice({ notice, onClose }) {
  useEffect(() => {
    if (!notice) return
    const t = setTimeout(onClose, notice.undo ? 10000 : 6000)
    return () => clearTimeout(t)
  }, [notice, onClose])
  if (!notice) return null
  return (
    <div className={`notice ${notice.tone || 'info'}`} role={notice.tone === 'error' ? 'alert' : 'status'}>
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
          : <>{url}에 연결을 시도하고 있습니다. GB10에서 ROS 스택(docker compose)이 실행 중인지 확인하세요. 다른 주소라면 주소창 끝에 <code>?ros=ws://IP:9090</code>을 붙여 접속합니다.</>}
      </Hint>
    </div>
  )
}
