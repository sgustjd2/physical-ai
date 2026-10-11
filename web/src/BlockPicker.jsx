// 블록 선택 창 (Dify 블록 선택 참고): 검색 + 분류별 목록 + 한 줄 설명.
// 툴바 '블록 추가', 노드 출력의 +, 연결선 가운데 + 가 모두 이 창을 연다. 무엇을 할지는 onPick을 넘긴 쪽이 정한다.
import { useContext, useEffect, useRef, useState } from 'react'
import { Icon } from './icons'
import { Specs } from './nodes'

const W = 300

// 버튼 아래(공간이 없으면 위)에 붙인다
export const anchorOf = (el) => {
  const r = el.getBoundingClientRect()
  const left = Math.min(Math.max(8, r.left + r.width / 2 - W / 2), innerWidth - Math.min(W, innerWidth - 16) - 8)
  return innerHeight - r.bottom >= 300
    ? { left, top: r.bottom + 6, maxHeight: Math.min(460, innerHeight - r.bottom - 18) }
    : { left, bottom: innerHeight - r.top + 6, maxHeight: Math.min(460, r.top - 18) }
}

function Item({ s, colorOf, onPick }) {
  return (
    <button className="pick-item" style={{ '--cat': colorOf(s.type) }} onClick={() => onPick(s.type)}>
      <span className="node-icon" aria-hidden="true">{s.icon ? <Icon name={s.icon} size={14} /> : <span className="node-dot" />}</span>
      <span className="pick-text">
        <span className="pick-label">{s.label}</span>
        {s.desc && <span className="pick-desc">{s.desc}</span>}
      </span>
    </button>
  )
}

export function BlockPicker({ anchor, title, live, onPick, onClose }) {
  const { specs, colorOf } = useContext(Specs)
  const [q, setQ] = useState('')
  const ref = useRef()

  // 닫히면 연 버튼으로 포커스를 돌려줌 (블록을 넣었으면 App이 새 블록으로 옮김)
  useEffect(() => {
    const opener = document.activeElement
    return () => { if (opener?.isConnected && (!document.activeElement || document.activeElement === document.body || ref.current?.contains(document.activeElement))) opener.focus() }
  }, [])

  useEffect(() => {
    const outside = (e) => { if (!ref.current?.contains(e.target)) onClose() }
    const esc = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    // 여는 클릭·자동 포커스가 곧바로 '바깥 클릭/스크롤'로 잡히지 않게 다음 틱에 건다
    // 바깥이 스크롤되면 붙어 있던 버튼에서 떨어지므로 닫는다 (목록 안 스크롤은 그대로).
    // resize로는 닫지 않음: 태블릿에서 검색창에 포커스하면 화면 키보드가 resize를 일으킨다
    const scroll = (e) => { if (!ref.current?.contains(e.target)) onClose() }
    const t = setTimeout(() => { addEventListener('pointerdown', outside); addEventListener('scroll', scroll, true) })
    addEventListener('keydown', esc, true)
    return () => {
      clearTimeout(t)
      removeEventListener('pointerdown', outside)
      removeEventListener('keydown', esc, true)
      removeEventListener('scroll', scroll, true)
    }
  }, [onClose])

  const all = Object.values(specs)
  const words = q.trim().toLowerCase()
  const hits = words ? all.filter((s) => [s.label, s.desc, s.type, s.group].some((v) => v?.toLowerCase().includes(words))) : all
  const basic = hits.filter((s) => !s.advanced)
  const advanced = hits.filter((s) => s.advanced)
  const groups = [...new Set(basic.map((s) => s.group || '기타'))]
  const pick = (type) => { onPick(type); onClose() }

  return (
    <div className="picker" ref={ref} role="dialog" aria-label={title} style={{ ...anchor, width: `min(${W}px, calc(100vw - 16px))` }}
      onKeyDown={(e) => {
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
        const items = [...ref.current.querySelectorAll('.pick-item')].filter((b) => b.offsetParent)
        const i = items.indexOf(document.activeElement)
        const next = items[e.key === 'ArrowDown' ? i + 1 : i - 1]
        e.preventDefault()
        if (next) next.focus()
        else if (e.key === 'ArrowUp') ref.current.querySelector('input')?.focus()
      }}
      onBlur={(e) => { if (e.relatedTarget && !ref.current?.contains(e.relatedTarget)) onClose() }}>
      <div className="picker-head">
        <span className="picker-title">{title}</span>
        <input type="search" name="blockSearch" autoComplete="off" spellCheck={false} autoFocus value={q}
          onChange={(e) => setQ(e.target.value)} placeholder="블록 검색…" aria-label="블록 검색"
          onKeyDown={(e) => { if (e.key === 'Enter' && hits[0]) pick((basic[0] || advanced[0]).type) }} />
      </div>
      <div className="picker-body">
        {!all.length && <p className="muted empty">실행기 연결을 기다리는 중…</p>}
        {!!all.length && !live && <p className="hint-text">마지막으로 받은 블록 목록입니다 (실행기 연결 안 됨).</p>}
        {!!all.length && !hits.length && <p className="muted empty">'{q}'에 맞는 블록이 없습니다.</p>}
        {groups.map((g) => (
          <div key={g} role="group" aria-label={g} className="pick-group">
            <span className="pick-group-label">{g}</span>
            {basic.filter((s) => (s.group || '기타') === g).map((s) => <Item key={s.type} s={s} colorOf={colorOf} onPick={pick} />)}
          </div>
        ))}
        {advanced.length > 0 && (
          <details className="pick-advanced" open={!!words}>
            <summary>고급 <span className="muted">ROS 토픽 직접 다루기</span></summary>
            {advanced.map((s) => <Item key={s.type} s={s} colorOf={colorOf} onPick={pick} />)}
          </details>
        )}
      </div>
    </div>
  )
}
