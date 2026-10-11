// 운영 화면: 현장 작업자가 한눈에 보는 작업 상태·진행, 멈췄을 때 할 일, 오늘·최근 14일 운영 현황 (편집 없이 실행·정지만).
// 실행기 상태(/workflow/status)와 운영 기록 요약(/workflow/runs)만 읽는다.
import { useState } from 'react'
import { Hint } from './Hint'
import { Icon } from './icons'
import { recoveryGuide } from './recovery'
import { STATE_LABEL, useRunTimer } from './Status'

const MODE = { real: '실제 로봇', sim: '시뮬레이션' }
const RESULT = { done: '완료', stopped: '정지됨', error: '오류' }
const PERIOD = { today: '오늘', days: '최근 14일' }
// 값이 없으면 null (그 기간 기록 없음). lowerBetter: 줄어들수록 좋은 지표 (증감 색에만 씀)
const KPIS = [
  { key: 'runs', label: '실행', unit: '회', def: '실행·시뮬레이션 버튼으로 시작한 워크플로 수. 조그·홈 이동·단계 시험은 세지 않습니다', get: (s) => s.runs },
  { key: 'rate', label: '완료율', unit: '%', def: '끝까지 완료한 실행 ÷ 전체 실행', get: (s) => (s.runs ? Math.round((s.done / s.runs) * 100) : null) },
  { key: 'avg', label: '평균 소요', unit: '초', def: '완료한 실행의 평균 시간 (사이클 타임)', get: (s) => s.avg_s, lowerBetter: true, digits: 1 },
  { key: 'cycles', label: '처리 반복', unit: '회', def: '반복 블록이 끝낸 반복 수 (예: 집기·옮기기·놓기 한 바퀴 = 1회)', get: (s) => s.cycles },
  { key: 'fail', label: '정지·오류', unit: '회', def: '중간에 정지했거나 오류로 끝난 실행', get: (s) => s.stopped + s.error, lowerBetter: true },
]
const fmt = (v, digits = 0) => (v == null ? '—' : v.toLocaleString('ko-KR', { minimumFractionDigits: digits, maximumFractionDigits: digits }))
const md = (d) => `${+d.slice(5, 7)}월 ${+d.slice(8, 10)}일`

// 여러 날 요약 합치기 (평균 소요는 완료 수로 가중)
function sum(days, mode) {
  const s = { runs: 0, done: 0, stopped: 0, error: 0, cycles: 0, avg_s: null }
  let secs = 0
  for (const d of days) {
    const x = d[mode]
    for (const k of ['runs', 'done', 'stopped', 'error', 'cycles']) s[k] += x[k]
    secs += (x.avg_s || 0) * x.done
  }
  if (s.done) s.avg_s = Math.round((secs / s.done) * 10) / 10
  return s
}

// 비교 문구: vs = '어제' | '이전 14일'. 증감은 색만이 아니라 ▲▼·숫자·문구로
function Delta({ now, prev, k, vs }) {
  if (now == null) return <span className="ops-delta">기록 없음</span>
  if (prev == null) return <span className="ops-delta">{vs} 기록 없음</span>
  const d = Math.round((now - prev) * 10) / 10
  if (!d) return <span className="ops-delta">{vs} 대비 변화 없음</span>
  const better = k.lowerBetter ? d < 0 : d > 0
  return (
    <span className={`ops-delta ${better ? 'up' : 'down'}`}>
      {vs} 대비 <b>{d > 0 ? '▲' : '▼'} {fmt(Math.abs(d), k.digits)}</b>
    </span>
  )
}

// 일별 실행 막대 (완료 / 정지·오류 쌓기). 0에서 시작, 스크린리더는 아래 표를 읽는다
function DayBars({ days, mode }) {
  const top = Math.max(1, ...days.map((d) => d[mode].runs))
  const max = top <= 2 ? 2 : Math.ceil(top / 4) * 4 // 가운데 눈금(max/2)도 정수가 되게
  return (
    <figure className="ops-chart">
      <figcaption>
        일별 실행 ({MODE[mode]})
        <span className="ops-legend" aria-hidden="true"><i className="done" />완료<i className="fail" />정지·오류</span>
      </figcaption>
      <div className="ops-bars" aria-hidden="true">
        <span className="ops-axis"><b>{max}</b><b>{max / 2}</b><b>0</b></span>
        {days.map((d) => {
          const x = d[mode]
          const fail = x.stopped + x.error
          return (
            <span key={d.date} className="ops-bar" title={`${md(d.date)}: 실행 ${x.runs}회 (완료 ${x.done}, 정지·오류 ${fail})`}>
              <span className="ops-bar-stack">
                <i className="fail" style={{ height: `${(fail / max) * 100}%` }} />
                <i className="done" style={{ height: `${(x.done / max) * 100}%` }} />
              </span>
              <small>{+d.date.slice(8, 10)}</small>
            </span>
          )
        })}
      </div>
      <table className="sr-only">
        <caption>일별 실행 ({MODE[mode]})</caption>
        <thead><tr><th scope="col">날짜</th><th scope="col">실행</th><th scope="col">완료</th><th scope="col">정지·오류</th></tr></thead>
        <tbody>{days.map((d) => <tr key={d.date}><td>{md(d.date)}</td><td>{d[mode].runs}</td><td>{d[mode].done}</td><td>{d[mode].stopped + d[mode].error}</td></tr>)}</tbody>
      </table>
    </figure>
  )
}

// 일별 요약 CSV (엑셀에서 한글이 깨지지 않게 BOM). 실제 로봇·시뮬레이션 둘 다
function exportCsv(days) {
  const head = ['날짜', '구분', '실행', '완료', '정지', '오류', '완료율(%)', '평균 소요(초)', '처리 반복']
  const rows = days.flatMap((d) => Object.entries(MODE).map(([m, label]) => {
    const x = d[m]
    return [d.date, label, x.runs, x.done, x.stopped, x.error, x.runs ? Math.round((x.done / x.runs) * 100) : '', x.avg_s ?? '', x.cycles]
  }))
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob(['﻿' + [head, ...rows].map((r) => r.join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' }))
  a.download = `운영기록_${days[0].date}_${days.at(-1).date}.csv`
  a.click()
  URL.revokeObjectURL(a.href)
}

export function OpsView({ status, steps, labelOf, runs, connected, viewer, onFocusNode, onHome }) {
  const [mode, setMode] = useState('real')
  const [period, setPeriod] = useState('today')
  const t = useRunTimer(status)
  const state = status.estop ? 'estop' : status.state
  const act = status.active?.length ? status.active : [status.node]
  const idx = Math.max(...act.map((id) => steps.indexOf(id)))
  const [done, total] = status.loop || []
  const guide = recoveryGuide(status)
  const days = runs?.days?.length === 28 ? runs.days : null
  const cur = period === 'today' ? runs?.today?.[mode] : days && sum(days.slice(14), mode)
  const prev = period === 'today' ? runs?.yesterday?.[mode] : days && sum(days.slice(0, 14), mode)
  const vs = period === 'today' ? '어제' : '이전 14일'
  return (
    <div className={`ops${connected ? '' : ' stale'}`}>
      <div className="ops-side">
        <section className={`ops-tile ops-state ${state}`} aria-label="작업 상태">
          <span className="ops-label">작업 상태</span>
          <strong className="ops-big"><span className="dot" aria-hidden="true" />{state === 'estop' ? '비상정지' : STATE_LABEL[state] ?? state}</strong>
          <span className="ops-sub">{state === 'idle' ? '실행 버튼으로 시작합니다' : MODE[status.mode] || ''}</span>
        </section>
        {guide && (
          <section className={`ops-guide ${state}`} aria-labelledby="ops-guide-title">
            <h3 id="ops-guide-title"><Icon name="alert" />{guide.title}</h3>
            <p>{guide.todo}</p>
            {guide.detail && <p className="ops-guide-detail" title={guide.detail}>{guide.detail}</p>}
            {guide.actions.length > 0 && (
              <div className="ops-guide-actions">
                {guide.actions.includes('edit') && status.node && (
                  <button onClick={() => onFocusNode(status.node)}>문제 단계 보기</button>
                )}
                {guide.actions.includes('home') && (
                  <button onClick={onHome} disabled={!connected || status.estop}><Icon name="home" />홈으로 이동</button>
                )}
              </div>
            )}
          </section>
        )}
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
          <h3 id="ops-kpi-title">
            운영 현황
            <span className="ops-period">
              {period === 'today' ? (runs?.date ? `${md(runs.date)} · 어제와 비교` : '') : days ? `${md(days[14].date)}~${md(days[27].date)} · 이전 14일과 비교` : ''}
            </span>
          </h3>
          <div className="ops-kpi-tools">
            <div className="segmented" role="radiogroup" aria-label="기간">
              {Object.entries(PERIOD).map(([p, label]) => (
                <button key={p} role="radio" aria-checked={period === p} onClick={() => setPeriod(p)}>{label}</button>
              ))}
            </div>
            <div className="segmented" role="radiogroup" aria-label="집계 대상">
              {Object.entries(MODE).map(([m, label]) => (
                <button key={m} role="radio" aria-checked={mode === m} onClick={() => setMode(m)}>{label}</button>
              ))}
            </div>
            {period === 'days' && (
              <button className="ghost" onClick={() => exportCsv(days)} disabled={!days} title="최근 28일 일별 요약을 CSV로 저장 (실제 로봇·시뮬레이션)">
                <Icon name="download" /><span className="label">CSV</span>
              </button>
            )}
          </div>
        </div>
        <div className="ops-kpi-grid">
          {KPIS.map((k) => (
            <div key={k.key} className="ops-kpi">
              <span className="ops-label">{k.label}<Hint label={`${k.label} 정의`}>{k.def}</Hint></span>
              <strong>{fmt(cur ? k.get(cur) : null, k.digits)}<small>{k.unit}</small></strong>
              {cur ? <Delta now={k.get(cur)} prev={prev ? k.get(prev) : null} k={k} vs={vs} /> : <span className="ops-delta">{runs ? '기록 없음' : '받는 중…'}</span>}
            </div>
          ))}
        </div>
        {period === 'days' && days && <DayBars days={days.slice(14)} mode={mode} />}
      </section>
    </div>
  )
}
