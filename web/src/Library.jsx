// '열기' 메뉴: GB10에 저장된 워크플로 목록 (ros/workflow_store.py) + 파일 불러오기/내보내기
import { useEffect, useRef, useState } from 'react'
import { EXAMPLES } from './examples'
import { Icon } from './icons'

const when = new Intl.DateTimeFormat('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })

export function LibraryMenu({ items, connected, onOpen, onDelete, onImportFile, onExportFile }) {
  const [open, setOpen] = useState(false)
  const ref = useRef()
  useEffect(() => {
    if (!open) return
    const outside = (e) => { if (!ref.current?.contains(e.target)) setOpen(false) }
    const esc = (e) => { if (e.key === 'Escape') setOpen(false) }
    addEventListener('pointerdown', outside)
    addEventListener('keydown', esc)
    return () => { removeEventListener('pointerdown', outside); removeEventListener('keydown', esc) }
  }, [open])
  const pick = (fn) => () => { setOpen(false); fn() }
  return (
    <div className="menu" ref={ref}>
      <button className="ghost" aria-expanded={open} aria-controls="library-panel" onClick={() => setOpen((o) => !o)}
        title="GB10에 저장된 워크플로 열기">
        <Icon name="folder" /><span className="label">열기</span>
      </button>
      {open && (
        <div className="menu-panel" id="library-panel">
          <div className="menu-title">GB10에 저장된 워크플로</div>
          {!connected && <p className="muted menu-empty">연결되면 목록이 표시됩니다.</p>}
          {connected && !items.length && <p className="muted menu-empty">아직 저장한 워크플로가 없습니다. 지금 화면을 '저장'하면 여기에 나타납니다.</p>}
          {!!items.length && (
            <ul className="menu-list">
              {items.map((w) => (
                <li key={w.name}>
                  <button className="menu-item" onClick={pick(() => onOpen(w))}>
                    <span className="menu-item-name">{w.name}</span>
                    <span className="muted">{w.updated ? when.format(new Date(w.updated)) : ''}</span>
                  </button>
                  <button className="icon-btn" onClick={() => onDelete(w)} aria-label={`${w.name} 삭제`} title="삭제 (되돌리기 가능)">
                    <Icon name="trash" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="menu-sep" />
          <div className="menu-title">예제</div>
          {EXAMPLES.map((w) => (
            <button key={w.name} className="menu-item" onClick={pick(() => onOpen(w, true))}>
              <span className="menu-item-name">{w.name}</span>
            </button>
          ))}
          <div className="menu-sep" />
          <button className="menu-item" onClick={pick(onImportFile)}><Icon name="upload" />파일에서 불러오기…</button>
          <button className="menu-item" onClick={pick(onExportFile)}><Icon name="download" />파일로 내보내기</button>
        </div>
      )}
    </div>
  )
}
