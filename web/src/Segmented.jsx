// 버튼 묶음(라디오 그룹): 여럿 중 하나를 고른다. 탭 한 번으로 들어오고 화살표·Home·End로 옮기며 바로 고른다 (WAI-ARIA 라디오 그룹).
// options: [[값, 보이는 글자, title?]]
const STEP = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }

export function Segmented({ label, options, value, onChange, disabled, className = '' }) {
  const at = options.findIndex(([v]) => v === value)
  const onKeyDown = (e) => {
    const n = options.length
    const j = e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : e.key in STEP ? (Math.max(at, 0) + STEP[e.key] + n) % n : -1
    if (j < 0) return
    e.preventDefault()
    onChange(options[j][0])
    e.currentTarget.querySelectorAll('[role="radio"]')[j]?.focus()
  }
  return (
    <div className={`segmented ${className}`.trim()} role="radiogroup" aria-label={label} onKeyDown={onKeyDown}>
      {options.map(([v, text, title], i) => (
        <button key={v} role="radio" aria-checked={value === v} tabIndex={i === Math.max(at, 0) ? 0 : -1}
          disabled={disabled} title={title} onClick={() => onChange(v)}>{text}</button>
      ))}
    </div>
  )
}
