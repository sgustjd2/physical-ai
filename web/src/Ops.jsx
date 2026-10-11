// 운영 화면: 현장 작업자가 한눈에 보는 작업 상태·진행, 멈췄을 때 할 일, 오늘·최근 14일 운영 현황 (편집 없이 실행·정지만).
// 실행기 상태(/workflow/status)와 운영 기록 요약(/workflow/runs)만 읽는다.
import { useState } from 'react'
import { Hint } from './Hint'
import { Icon } from './icons'
import { recoveryGuide } from './recovery'
import { Segmented } from './Segmented'
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
// 보기 선택(기간·집계 대상)은 이 브라우저에 기억 (저장이 막혀도 동작)
const remembered = (key, init) => { try { return localStorage.getItem(key) || init } catch { return init } }
const remember = (key, v) => { try { localStorage.setItem(key, v) } catch { /* 저장 불가 */ } }

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

// 비교 문구: vs = '어제' | '이전 14일'. 증감은 색만이 아니라 화살표·숫자·문구로
function Delta({ now, prev, k, vs }) {
  if (now == null) return <span className="ops-delta">—</span>
  if (prev == null) return <span className="ops-delta">{vs} 기록 없음</span>
  const d = Math.round((now - prev) * 10) / 10
  if (!d) return <span className="ops-delta">{vs} 대비 변화 없음</span>
  const better = k.lowerBetter ? d < 0 : d > 0
  return (
    <span className={`ops-delta ${better ? 'up' : 'down'}`}>
      {vs} 대비 <b><Icon name={d > 0 ? 'up' : 'down'} size={12} />{d > 0 ? '증가' : '감소'} {fmt(Math.abs(d), k.digits)}</b>
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
              <small className="ops-bar-val">{x.runs || ''}</small>
              <span className="ops-bar-stack">
                <i className="fail" style={{ height: `${(fail / max) * 100}%` }} />
                <i className="done" style={{ height: `${(x.done / max) * 100}%` }} />
              </span>
              <small>{+d.date.slice(8, 10)}</small>
            </span>
          )
        })}
      </div>
      {/* 표는 display:table 이라 .sr-only 크기(1px)를 무시하고 자리를 차지함 → 감싸서 숨김 */}
      <div className="sr-only">
        <table>
          <caption>일별 실행 ({MODE[mode]})</caption>
          <thead><tr><th scope="col">날짜</th><th scope="col">실행</th><th scope="col">완료</th><th scope="col">정지·오류</th></tr></thead>
          <tbody>{days.map((d) => <tr key={d.date}><td>{md(d.date)}</td><td>{d[mode].runs}</td><td>{d[mode].done}</td><td>{d[mode].stopped + d[mode].error}</td></tr>)}</tbody>
        </table>
      </div>
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

export function OpsView({ status, steps, labelOf, runs, connected, viewer, name, hasLoop, onFix, onHome, onRerun }) {
  const [mode, setModeState] = useState(() => remembered('ops.mode', 'real'))
  const [period, setPeriodState] = useState(() => remembered('ops.period', 'today'))
  const setMode = (m) => { setModeState(m); remember('ops.mode', m) }
  const setPeriod = (p) => { setPeriodState(p); remember('ops.period', p) }
  const t = useRunTimer(status)
  // 신호등: 연결 끊김(회색) / 실행 중(파랑) / 완료(초록) / 정지(노랑) / 오류·비상정지(빨강)
  const state = !connected ? 'offline' : status.estop ? 'estop' : status.state
  const act = status.active?.length ? status.active : [status.node]
  const idx = Math.max(...act.map((id) => steps.indexOf(id)))
  const [done, total] = status.loop || []
  const guide = recoveryGuide({ ...status, connected })
  const days = runs?.days?.length === 28 ? runs.days : null
  const cur = period === 'today' ? runs?.today?.[mode] : days && sum(days.slice(14), mode)
  const prev = period === 'today' ? runs?.yesterday?.[mode] : days && sum(days.slice(0, 14), mode)
  const vs = period === 'today' ? '어제' : '이전 14일'
  const lastDone = runs?.recent?.find((r) => r.name === name && r.mode === status.mode && r.state === 'done')
  const where = { running: `${idx + 1} / ${steps.length}단계`, stopped: `${idx + 1} / ${steps.length}단계에서 멈춤`, error: `${idx + 1} / ${steps.length}단계에서 멈춤` }
  const seg = (i) => (status.state === 'done' ? 'past' : i < idx ? 'past' : i === idx ? 'now' : '')
  return (
    <div className="ops">
      <div className="ops-side">
        <section className={`ops-tile ops-state ${state}`} aria-label="작업 상태">
          <span className="ops-label">작업 상태</span>
          <strong className="ops-state-word">
            <span className="dot" aria-hidden="true" />
            {{ offline: '연결 끊김', estop: '비상정지' }[state] ?? STATE_LABEL[state] ?? state}
          </strong>
          {state === 'offline' ? <span className="ops-sub">마지막으로 받은 상태: {STATE_LABEL[status.state] ?? status.state}</span>
            : state === 'idle' ? <span className="ops-sub">위쪽 실행 버튼으로 시작합니다</span>
              : status.mode && <span className={`mode ${status.mode}`}>{MODE[status.mode]}</span>}
        </section>
        {guide && (
          <section className={`ops-guide ${state}`} role={state === 'stopped' ? 'status' : 'alert'} aria-labelledby="ops-guide-title">
            <h2 id="ops-guide-title"><Icon name="alert" />{guide.title}</h2>
            <p>{guide.todo}</p>
            {guide.detail && (
              <details className="ops-guide-detail">
                <summary>오류 원문</summary>
                <p>{guide.detail}</p>
              </details>
            )}
            {guide.actions.length > 0 && (
              <div className="ops-guide-actions">
                {guide.actions.includes('edit') && status.node && <button onClick={() => onFix(status.node, guide.todo)}>문제 단계 보기</button>}
                {guide.actions.includes('home') && <button onClick={onHome} disabled={!connected || status.estop}><Icon name="home" />홈으로 이동</button>}
                {guide.actions.includes('rerun') && <button onClick={onRerun} disabled={!connected || status.estop}><Icon name="sim" />다시 시뮬레이션</button>}
              </div>
            )}
          </section>
        )}
        <section className={`ops-tile ops-step ${state}`} aria-label="현재 단계">
          <span className="ops-label">현재 단계</span>
          <strong className="ops-mid">{status.node && status.state !== 'idle' && status.state !== 'done' ? labelOf(status.node) : '—'}</strong>
          <span className="ops-sub">{status.state === 'done' ? `${steps.length}단계 모두 완료` : idx >= 0 && where[status.state] ? where[status.state] : `${steps.length}단계 워크플로`}</span>
          {steps.length > 0 && steps.length <= 40 && (
            <span className="ops-steps" aria-hidden="true">{steps.map((s, i) => <i key={s} className={seg(i)} />)}</span>
          )}
        </section>
        {hasLoop && (
          <section className="ops-tile" aria-label="반복 진행">
            <span className="ops-label">반복 진행</span>
            {total ? (
              <>
                <strong className="ops-big">{done} <small>/ {total}회</small></strong>
                <progress max={total} value={done} aria-label={`반복 ${total}회 중 ${done}회 완료`} />
              </>
            ) : <><strong className="ops-big">—</strong><span className="ops-sub">실행하면 반복 횟수가 보입니다</span></>}
          </section>
        )}
        <section className="ops-tile" aria-label={status.state === 'running' ? '경과 시간' : '마지막 실행 시간'}>
          <span className="ops-label">{status.state === 'running' ? '경과 시간' : '마지막 실행 시간'}</span>
          <strong className="ops-big">{t == null ? '—' : <>{fmt(t, 1)} <small>초</small></>}</strong>
          {status.state === 'running' && lastDone && <span className="ops-sub">지난 완료 {fmt(lastDone.seconds, 1)}초</span>}
        </section>
        <section className="ops-recent" aria-labelledby="ops-recent-title">
          <h2 id="ops-recent-title">최근 실행</h2>
          {!runs ? <p className="ops-empty">기록을 받는 중…</p> : !runs.recent?.length ? (
            <p className="ops-empty">아직 실행 기록이 없습니다. 실행 버튼으로 워크플로를 시작하면 여기에 쌓입니다.</p>
          ) : (
            <table>
              <thead><tr><th scope="col">시작</th><th scope="col">워크플로</th><th scope="col">결과</th><th scope="col" className="num">소요</th></tr></thead>
              <tbody>
                {runs.recent.map((r) => (
                  <tr key={r.start + r.name}>
                    {/* 오늘이면 시:분, 지난 날이면 월/일 */}
                    <td className="num" title={r.start.replace('T', ' ').slice(0, 16)}>
                      {r.start.slice(0, 10) === runs.date ? r.start.slice(11, 16) : `${+r.start.slice(5, 7)}/${+r.start.slice(8, 10)}`}
                    </td>
                    <td className="name">
                      <span>{r.name}</span>{r.mode === 'sim' && <span className="ops-tag">시뮬</span>}
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
          <div className="ops-kpi-title">
            <h2 id="ops-kpi-title">운영 현황</h2>
            <p className="ops-period">
              {period === 'today' ? (runs?.date ? `${md(runs.date)} · 어제와 비교` : '') : days ? `${md(days[14].date)}~${md(days[27].date)} · 이전 14일과 비교` : ''}
              {!connected && runs && ' · 연결이 끊겨 마지막으로 받은 값'}
            </p>
          </div>
          <div className="ops-kpi-tools">
            <Segmented label="기간" options={Object.entries(PERIOD)} value={period} onChange={setPeriod} />
            <Segmented label="집계 대상" options={Object.entries(MODE)} value={mode} onChange={setMode} />
            {period === 'days' && (
              <button className="ghost" onClick={() => exportCsv(days)} disabled={!days} title="최근 28일 일별 요약을 CSV로 저장 (실제 로봇·시뮬레이션)">
                <Icon name="download" /><span className="label">CSV</span>
              </button>
            )}
          </div>
        </div>
        <div className="ops-kpi-grid">
          {KPIS.map((k) => {
            const v = cur ? k.get(cur) : null
            return (
              <div key={k.key} className="ops-kpi">
                <span className="ops-label">{k.label}<Hint label={`${k.label} 정의`}>{k.def}</Hint></span>
                <strong>{fmt(v, k.digits)}{v != null && <small>{k.unit}</small>}</strong>
                {!runs ? <span className="ops-delta">받는 중…</span>
                  : !cur?.runs ? <span className="ops-delta">실행 기록 없음</span>
                    : <Delta now={v} prev={prev?.runs ? k.get(prev) : null} k={k} vs={vs} />}
              </div>
            )
          })}
        </div>
        {period === 'days' && days && <DayBars days={days.slice(14)} mode={mode} />}
      </section>
    </div>
  )
}
