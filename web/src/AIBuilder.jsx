// 'AI로 만들기': 작업을 말로 설명하면 AI가 지금 서버에 있는 노드만으로 시나리오를 만든다 (ros/scenario_ai.py).
// 결과는 바로 실행하지 않고 요약·경고를 보여 준 뒤 편집기로 불러온다 → 사람이 확인하고 시뮬레이션으로 검증.
import { useEffect, useRef, useState } from 'react'
import { Icon } from './icons'
import { sendGenerate } from './ros'

const EXAMPLE = '작업대에 부품이 보이면 집어서 오른쪽 상자에 넣고, 없으면 3초 기다렸다가 다시 확인해. 이걸 5번 반복하고 끝나면 홈 자세로.'

export function AIBuilder({ gen, connected, onLoad }) {
  const [open, setOpen] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [reqId, setReqId] = useState(null)
  const [lost, setLost] = useState(null)
  const ref = useRef()
  const genRef = useRef(gen)
  const result = reqId && gen.ack === reqId ? gen : null
  const busy = !!reqId && !result && lost !== reqId
  useEffect(() => { genRef.current = gen }, [gen])

  useEffect(() => {
    if (!open) return
    const outside = (e) => { if (!ref.current?.contains(e.target)) setOpen(false) }
    const esc = (e) => { if (e.key === 'Escape') setOpen(false) }
    addEventListener('pointerdown', outside)
    addEventListener('keydown', esc)
    return () => { removeEventListener('pointerdown', outside); removeEventListener('keydown', esc) }
  }, [open])

  const submit = (e) => {
    e.preventDefault()
    if (!prompt.trim()) return
    const id = sendGenerate(prompt.trim())
    setReqId(id)
    // 생성기가 꺼져 있거나 명령이 유실되면 접수 응답(busy)이 오지 않는다 → 계속 '만드는 중'에 묶이지 않게 다시 시도할 수 있게 함
    setTimeout(() => { const g = genRef.current; if (g.busy !== id && g.ack !== id) setLost(id) }, 8000)
  }
  return (
    <div className="menu" ref={ref}>
      <button className={`ghost ai-btn${busy ? ' busy' : ''}`} aria-expanded={open} aria-controls="ai-panel" onClick={() => setOpen((o) => !o)}
        title="작업을 말로 설명하면 AI가 워크플로를 만듭니다">
        <Icon name="spark" /><span className="label">AI로 만들기</span>
      </button>
      {open && (
        <form className="menu-panel ai-panel" id="ai-panel" onSubmit={submit}>
          <label className="field">
            <span className="field-label">만들고 싶은 작업을 설명하세요</span>
            <textarea rows={4} name="scenario" autoComplete="off" value={prompt} onChange={(e) => setPrompt(e.target.value)}
              placeholder={`예: ${EXAMPLE}`} />
          </label>
          <div className="row">
            <button type="submit" className="primary" disabled={!connected || busy || !prompt.trim()}>
              <Icon name="spark" />{busy ? '만드는 중…' : '시나리오 만들기'}
            </button>
            {!prompt && <button type="button" onClick={() => setPrompt(EXAMPLE)}>예시 넣기</button>}
          </div>
          <div aria-live="polite">
            {busy && <p className="hint-text">AI가 시나리오를 설계하는 중입니다. 보통 수십 초 걸립니다.</p>}
            {result?.error && <p className="error-text">{result.error}</p>}
            {reqId && lost === reqId && <p className="error-text">AI 생성기가 응답하지 않습니다. ROS 스택에서 scenario_ai가 실행 중인지 확인하고 다시 시도하세요.</p>}
            {result?.graph && (
              <div className="ai-result">
                <p className="ai-summary">{result.summary}</p>
                {!!result.warnings?.length && (
                  <ul className="ai-warnings">{result.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
                )}
                <button type="button" className="primary" onClick={() => { onLoad(result.graph); setOpen(false) }}>
                  편집기로 불러오기 ({result.graph.nodes.length - 1}단계)
                </button>
                <p className="hint-text">불러온 뒤 자세 값을 확인하고, 실제 실행 전에 '시뮬레이션'으로 검증하세요.</p>
              </div>
            )}
          </div>
        </form>
      )}
    </div>
  )
}
