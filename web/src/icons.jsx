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
  copy: <path d="M9 9h9.5a.5.5 0 0 1 .5.5V19a.5.5 0 0 1-.5.5H9a.5.5 0 0 1-.5-.5V9.5A.5.5 0 0 1 9 9Zm-3.5 6H5a.5.5 0 0 1-.5-.5V5a.5.5 0 0 1 .5-.5h9.5a.5.5 0 0 1 .5.5v.5" />,
  home: <path d="M4 11 12 4l8 7M6.5 9v11h11V9M10 20v-5.5h4V20" />,
  estop: <><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="4.5" fill="currentColor" stroke="none" /></>,
  undo: <path d="M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />,
  redo: <path d="m15 14 5-5-5-5M20 9H9.5a5.5 5.5 0 0 0 0 11H13" />,
  duplicate: <path d="M8.5 8h11a.5.5 0 0 1 .5.5v11a.5.5 0 0 1-.5.5h-11a.5.5 0 0 1-.5-.5v-11a.5.5 0 0 1 .5-.5ZM14 11v6m-3-3h6M5 16V4.5a.5.5 0 0 1 .5-.5H16" />,
  paste: <path d="M9 3.5h6v3H9zM9 5H6.5a1 1 0 0 0-1 1v13.5a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1H15M9 12h6m-6 4h4" />,
  alert: <path d="M12 4.5 3 19.5h18L12 4.5ZM12 10v4.5m0 2.5v.5" />,
  info: <path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-10v5m0-8.5v.5" />,
  // 노드 분류 아이콘 (플러그인 ICON 값)
  arm: <path d="M4 20h9M8.5 20v-5l5-5m0 0 4 3.5m0 0 2.5-1.5M17.5 13.5 19 16M8.5 15a1.5 1.5 0 1 0 0 .01M13.5 10a1.5 1.5 0 1 0 0 .01" />,
  flow: <path d="M6 3v18M6 9c0 4 12 1 12 8m-3-3 3 3 3-3M6 9h.01" />,
  device: <path d="M7 6h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1Zm2-3v3m6-3v3M9 18v3m6-3v3M3 9h3m-3 6h3m12-6h3m-3 6h3M10 10h4v4h-4z" />,
  data: <path d="M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3Zm0 0v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />,
  vision: <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Zm10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" />,
  spark: <path d="M12 3v4m0 10v4M3 12h4m10 0h4M6.3 6.3l2.5 2.5m6.4 6.4 2.5 2.5m0-11.4-2.5 2.5m-6.4 6.4-2.5 2.5" />,
  sim: <path d="M12 3 4 7.5v9L12 21l8-4.5v-9L12 3Zm-8 4.5L12 12l8-4.5M12 12v9" />,
  save: <path d="M5 4h11l3 3v13H5V4Zm3 0v5h7V4M8 20v-6h8v6" />,
  folder: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />,
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
