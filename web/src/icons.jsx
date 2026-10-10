// 아이콘: 24px 그리드, 1.75 선 굵기 하나로 통일. 의미 없는 장식 아이콘은 쓰지 않는다.
const PATHS = {
  play: <path d="M7 4.8v14.4a.8.8 0 0 0 1.2.7l11.3-7.2a.8.8 0 0 0 0-1.4L8.2 4.1A.8.8 0 0 0 7 4.8Z" fill="currentColor" stroke="none" />,
  stop: <rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" stroke="none" />,
  record: <circle cx="12" cy="12" r="6" fill="currentColor" stroke="none" />,
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  download: <path d="M12 4v11m-5-5 5 5 5-5M5 20h14" />,
  upload: <path d="M12 20V9m-5 5 5-5 5 5M5 4h14" />,
  refresh: <path d="M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5" />,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  trash: <path d="M4 7h16M10 11v6m4-6v6M9 7V4.5h6V7M6 7l1 12.5h10L18 7" />,
  chevron: <path d="m6 9 6 6 6-6" />,
  layout: <path d="M8 3h8v5H8zM8 16h8v5H8zM12 8v8" />,
  view: <path d="M3 12a9 9 0 1 0 2.64-6.36M3 4v4.5h4.5" />,
  check: <path d="m5 12.5 4.5 4.5L19 7" />,
  info: <path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-10v5m0-8.5v.5" />,
  file: <path d="M14 3H6.5A1.5 1.5 0 0 0 5 4.5v15A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V8zM14 3v5h5M12 11v6m-3-3h6" />,
}

export function Icon({ name, size = 16 }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {PATHS[name]}
    </svg>
  )
}
