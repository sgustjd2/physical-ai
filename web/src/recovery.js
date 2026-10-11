// 운영 화면의 조치 안내: 실행이 오류·정지·비상정지로 끝났을 때 현장 작업자가 할 일 (recovery.test.js).
// 실행기 오류 문구(ros/nodes/*.py)를 보고 원인 한 줄 + 할 일 + 바로가기(edit: 문제 단계 보기, home: 홈으로)를 고른다.
const RULES = [
  [/범위\(/, '관절 목표가 로봇 범위를 벗어났습니다', '편집에서 이 단계의 관절 각도를 범위 안으로 고치세요', ['edit']],
  [/너무 빠름/, '이동이 속도 한계를 넘습니다', (m) => {
    const t = m.match(/(\d+(?:\.\d+)?)초 이상/)?.[1] // 실행기가 알려 준 최소 이동 시간
    return `편집에서 이 단계의 이동 시간을 ${t ? `${t}초 이상으로` : '더 길게'} 늘리세요`
  }, ['edit']],
  [/시뮬레이션 팔 응답 없음/, '디지털 트윈 팔이 응답하지 않습니다', '관리자에게 GB10 실행 환경 재시작을 요청하세요', []],
  [/액션 서버 응답 없음|목표를 거부|이동 실패/, '로봇팔이 명령을 받지 않습니다', '로봇 전원·비상정지 스위치·드라이버 연결을 확인한 뒤 다시 실행하세요', []],
  [/시간 초과/, '기다리던 신호가 오지 않았습니다', '센서·PLC 연결과 신호 조건을 확인하세요', ['edit']],
  [/카메라|이미지/, '카메라 영상을 받지 못했습니다', '오른쪽 카메라 화면에서 연결 상태를 확인하세요', []],
  [/토픽 없음/, '장비 신호(토픽)를 찾지 못했습니다', '장비가 켜져 있는지, 블록의 토픽 이름이 맞는지 확인하세요', ['edit']],
  [/AI가 확신하지 못함/, 'AI가 판단을 확신하지 못해 멈췄습니다', '카메라에 대상이 잘 보이는지 확인한 뒤 다시 실행하세요', []],
  [/AI |ANTHROPIC_API_KEY|anthropic/, 'AI 판단을 쓸 수 없습니다', '관리자에게 GB10의 AI 설정(API 키)을 확인해 달라고 하세요', []],
  [/녹화/, '녹화기에 문제가 있습니다', '오른쪽 녹화 탭의 상태를 확인하세요', []],
  [/데이터셋|에피소드/, '재생할 녹화 데이터가 없습니다', '편집에서 데이터셋과 에피소드를 다시 고르세요', ['edit']],
  [/없는 노드 타입/, '이 서버에 없는 블록이 있습니다', '편집에서 그 블록을 바꾸거나 지우세요', ['edit']],
]

// → { title, todo, detail(원문, 예외 이름 뺌), actions } | null (안내할 것 없음)
// mode: 'sim'이면 실제 팔은 움직이지 않았으므로 홈 이동(실제 팔을 움직임)을 권하지 않는다
export function recoveryGuide({ state, msg = '', estop, mode }) {
  const detail = msg.replace(/^\w+(?:Error|Exception): /, '')
  if (estop) return { title: '비상정지 중입니다', todo: '주변 안전을 확인한 뒤 위쪽 띠의 해제를 누르세요', detail: '', actions: [] }
  if (state === 'stopped' && mode === 'sim') return { title: '시뮬레이션을 멈췄습니다', todo: '실제 로봇은 움직이지 않았습니다. 다시 실행하면 처음부터 시작합니다', detail, actions: [] }
  if (state === 'stopped') return { title: '정지 버튼으로 멈췄습니다', todo: '팔 위치를 확인하고, 필요하면 홈으로 보낸 뒤 다시 실행하세요', detail, actions: ['home'] }
  if (state !== 'error') return null
  for (const [re, title, todo, actions] of RULES) {
    if (re.test(detail)) return { title, todo: typeof todo === 'function' ? todo(detail) : todo, detail, actions }
  }
  return { title: '실행 중 오류가 났습니다', todo: '아래 메시지를 확인하고 문제 단계를 편집에서 보세요', detail, actions: ['edit'] }
}
