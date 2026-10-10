// ⓘ 도움말 툴팁. 마우스 올림·키보드 포커스·터치 탭 모두로 열리고, 포커스가 빠지거나 Esc로 닫힌다.
// (클릭을 토글로 두면 포커스로 열린 직후 같은 클릭이 다시 닫아 버린다)
// 패널의 overflow에 잘리지 않도록 화면 기준(position: fixed)으로 띄운다.
import { useId, useLayoutEffect, useRef, useState } from 'react'
import { Icon } from './icons'

export function Hint({ children, label = '도움말' }) {
  const id = useId()
  const btn = useRef()
  const tip = useRef()
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState({ top: 0, left: 0 })

  useLayoutEffect(() => {
    if (!open) return
    const b = btn.current.getBoundingClientRect()
    const w = tip.current.offsetWidth
    const left = Math.min(Math.max(8, b.left + b.width / 2 - w / 2), innerWidth - w - 8)
    setPos({ top: b.bottom + 6, left })
  }, [open])

  return (
    <span className="hint" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button ref={btn} type="button" className="hint-btn" aria-label={label} aria-describedby={id}
        onClick={() => setOpen(true)} onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}
        onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}>
        <Icon name="info" size={15} />
      </button>
      <span ref={tip} id={id} role="tooltip" className="tooltip" style={pos} hidden={!open}>{children}</span>
    </span>
  )
}
