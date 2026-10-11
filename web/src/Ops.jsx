// 운영 화면: 현장 작업자가 한눈에 보는 작업 상태·진행과 오늘 운영 현황 (편집 없이 실행·정지만).
// 실행기 상태(/workflow/status)와 운영 기록 요약(/workflow/runs)만 읽는다.
import { useState } from 'react'
import { Hint } from './Hint'
import { STATE_LABEL, useRunTimer } from './Status'

const MODE = { real: '실제 로봇', sim: '시뮬레이션' }
const RESULT = { done: '완료', stopped: '정지됨', error: '오류' }
// 값이 없으면 null (그날 기록 없음). lowerBetter: 줄어들수록 좋은 지표 (증감 문구에만 씀)
const KPIS = [
  { key: 'runs', label: '실행', unit: '회', def: '실행·시뮬레이션 버튼으로 시작한 워크플로 수. 조그·홈 이동·단계 시험은 세지 않습니다', get: (s) => s.runs },
  { key: 'rate', label: '완료율', unit: '%', def: '끝까지 완료한 실행 ÷ 전체 실행', get: (s) => (s.runs ? Math.round((s.done / s.runs) * 100) : null) },
  { key: 'avg', label: '평균 소요', unit: '초', def: '완료한 실행의 평균 시간 (사이클 타임)', get: (s) => s.avg_s, lowerBetter: true, digits: 1 },
  { key: 'cycles', label: '처리 반복', unit: '회', def: '반복 블록이 끝낸 반복 수 (예: 집기·옮기기·놓기 한 바퀴 = 1회)', get: (s) => s.cycles },
  { key: 'fail', label: '정지·오류', unit: '회', def: '중간에 정지했거나 오류로 끝난 실행', get: (s) => s.stopped + s.error, lowerBetter: true },
]
const fmt = (v, digits = 0) => (v == null ? '—' : v.toLocaleString('ko-KR', { minimumFractionDigits: digits, maximumFractionDigits: digits }))

function Delta({ now, prev, k }) {
  if (now == null) return <span className="ops-delta">오늘 기록 없음</span>
  if (prev == null) return <span className="ops-delta">어제 기록 없음</span>
  const d = Math.round((now - prev) * 10) / 10
  if (!d) return <span className="ops-delta">어제와 같음</span>
  const better = k.lowerBetter ? d < 0 : d > 0
  return (
    <span className={`ops-delta ${better ? 'up' : 'down'}`}>
      어제 대비 <b>{d > 0 ? '▲' : '▼'} {fmt(Math.abs(d), k.digits)}</b>
    </span>
  )
}

export function OpsView({ status, steps, labelOf, runs, connected, viewer }) {
  const [mode, setMode] = useState('real')
  const t = useRunTimer(status)
  const state = status.estop ? 'estop' : status.state
  const act = status.active?.length ? status.active : [status.node]
  const idx = Math.max(...act.map((id) => steps.indexOf(id)))
  const [done, total] = status.loop || []
  const today = runs?.today?.[mode]
  const prev = runs?.yesterday?.[mode]
  const stale = !connected
  return (
    <div className={`ops${stale ? ' stale' : ''}`}>
      <div className="ops-side">
        <section className={`ops-tile ops-state ${state}`} aria-label="작업 상태">
          <span className="ops-label">작업 상태</span>
          <strong className="ops-big"><span className="dot" aria-hidden="true" />{state === 'estop' ? '비상정지' : STATE_LABEL[state] ?? state}</strong>
          <span className="ops-sub">{state === 'idle' ? '실행 버튼으로 시작합니다' : MODE[status.mode] || ''}</span>
        </section>
        <section className="ops-tile" aria-label="현재 단계">
          <span className="ops-label">현재 단계</span>
          <strong className="ops-mid" title={status.node ? labelOf(status.node) : ''}>
            {status.node && status.state !== 'idle' ? labelOf(status.node) : '—'}
          </strong>
          <span className="ops-sub">{idx >= 0 && status.state === 'running' ? `${idx + 1} / ${steps.length}단계${act.length > 1 ? ` · 병렬 ${act.length}개` : ''}` : `${steps.length}단계 워크플로`}</span>
        </section>
        <section className="ops-tile" aria-label="반복 진행">
          <span className="ops-label">반복 진행</span>
          {total ? (
            <>
              <strong className="ops-big">{done} <small>/ {total}회</small></strong>
              <progress max={total} value={done} aria-label={`반복 ${total}회 중 ${done}회 완료`} />
            </>
          ) : (
            <><strong className="ops-big">—</strong><span className="ops-sub">반복 블록이 아직 돌지 않았습니다</span></>
          )}
        </section>
        <section className="ops-tile" aria-label={status.state === 'running' ? '경과 시간' : '마지막 실행 시간'}>
          <span className="ops-label">{status.state === 'running' ? '경과 시간' : '마지막 실행 시간'}</span>
          <strong className="ops-big">{t == null ? '—' : <>{t.toFixed(1)} <small>초</small></>}</strong>
        </section>
        <section className="ops-recent" aria-labelledby="ops-recent-title">
          <h3 id="ops-recent-title" className="ops-label">최근 실행</h3>
          {!runs ? <p className="ops-empty">기록을 받는 중…</p> : !runs.recent?.length ? (
            <p className="ops-empty">아직 실행 기록이 없습니다. 실행 버튼으로 워크플로를 시작하면 여기에 쌓입니다.</p>
          ) : (
            <table>
              <thead><tr><th scope="col">시작</th><th scope="col">워크플로</th><th scope="col">결과</th><th scope="col" className="num">소요</th></tr></thead>
              <tbody>
                {runs.recent.map((r) => (
                  <tr key={r.start + r.name}>
                    <td className="num">{r.start.slice(11, 16)}</td>
                    <td className="name" title={`${r.name} · ${MODE[r.mode]}${r.cycles ? ` · 반복 ${r.cycles}회` : ''}`}>
                      {r.name}{r.mode === 'sim' && <span className="ops-tag">시뮬</span>}
                    </td>
                    <td><span className={`ops-result ${r.state}`}>{RESULT[r.state] || r.state}</span></td>
                    <td className="num">{fmt(r.seconds, 1)}초</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
      {viewer}
      <section className="ops-kpis" aria-labelledby="ops-kpi-title">
        <div className="ops-kpi-head">
          <h3 id="ops-kpi-title">오늘 운영 현황 <span className="ops-period">{runs?.date ? `${+runs.date.slice(5, 7)}월 ${+runs.date.slice(8, 10)}일 · 어제와 비교` : ''}</span></h3>
          <div className="segmented" role="radiogroup" aria-label="집계 대상">
            {Object.entries(MODE).map(([m, label]) => (
              <button key={m} role="radio" aria-checked={mode === m} onClick={() => setMode(m)}>{label}</button>
            ))}
          </div>
        </div>
        <div className="ops-kpi-grid">
          {KPIS.map((k) => (
            <div key={k.key} className="ops-kpi">
              <span className="ops-label">{k.label}<Hint label={`${k.label} 정의`}>{k.def}</Hint></span>
              <strong>{fmt(today ? k.get(today) : null, k.digits)}<small>{k.unit}</small></strong>
              {today ? <Delta now={k.get(today)} prev={prev ? k.get(prev) : null} k={k} /> : <span className="ops-delta">{runs ? '오늘 기록 없음' : '받는 중…'}</span>}
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
