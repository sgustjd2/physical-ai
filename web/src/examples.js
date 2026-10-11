// 시연·온보딩용 예제 워크플로. '열기' 메뉴에서 불러온다 (서버 저장소와 별개, 읽기 전용).
// 병렬 초기화 → 합류 → 3회 반복 { 접근 → AI 비전 판단(카메라) → (예) 내려가 집기·들어올리기·옮기기·놓기 / (아니오) 잠시 대기 } → 홈
// 관절 값은 demo_arm 작업 셀(robots/demo_arm/robot.yaml)에 맞춘 것: 툴 끝이 아래를 보며 부품(0.37, 0.27) 위 15cm → 부품 높이 → 상자(0.45, -0.32) 위
const mj = (id, x, y, joints, title) => ({ id, type: 'move_j', position: { x, y }, data: { title, joints, duration: 1.2 } })
const e = (source, target, sourceHandle) => ({ id: `${source}-${sourceHandle || 'out'}-${target}`, source, target, ...(sourceHandle ? { sourceHandle } : {}) })
const home = (id, x, y, title) => ({ id, type: 'move_home', position: { x, y }, data: { title, duration: 1.5 } }) // 로봇 프로파일의 홈 자세

export const EXAMPLES = [
  {
    name: '예제: AI 픽앤플레이스 (비전 판단·병렬·반복)',
    graph: {
      nodes: [
        { id: 'start', type: 'start', position: { x: 70, y: 0 }, data: {} },
        { id: 'grip_open', type: 'gripper', position: { x: -134, y: 80 }, data: { title: '그리퍼 열기', action: '열기', settle: 0.5 } },
        home('home', 134, 80, '홈 자세로'),
        { id: 'ready', type: 'join', position: { x: 50, y: 200 }, data: {} },
        { id: 'repeat', type: 'loop', position: { x: 0, y: 280 }, data: { title: '부품 3개 반복', count: 3 } },
        mj('approach', -134, 400, [36.1, 22.6, 111, 0, 46.5, 0], '부품 위로 접근'),
        home('home_end', 134, 400, '끝: 홈 자세로'),
        { id: 'check', type: 'vlm_check', position: { x: -134, y: 510 }, data: { title: 'AI 부품 확인', question: '그리퍼 아래 작업대에 집을 수 있는 부품이 있나요?', camera: '', timeout: 3, on_low: '정지', sim_result: '예' } },
        mj('pick', -268, 650, [36.1, 36.3, 111.9, 0, 31.7, 0], '내려가 집기'),
        { id: 'grip_close', type: 'gripper', position: { x: -268, y: 770 }, data: { title: '그리퍼 닫기', action: '닫기', settle: 0.5 } },
        mj('lift', -268, 880, [36.1, 22.6, 111, 0, 46.5, 0], '들어올리기'),
        { id: 'retry_wait', type: 'wait', position: { x: 0, y: 650 }, data: { title: '잠시 기다렸다 다시', sec: 1 } },
        mj('place', -268, 1000, [-35.4, 31.4, 93.7, 0, 54.9, 0], '상자 위로 옮기기'),
        { id: 'release', type: 'gripper', position: { x: -268, y: 1120 }, data: { title: '놓기', action: '열기', settle: 0.5 } },
      ],
      edges: [
        e('start', 'grip_open'), e('start', 'home'),
        e('grip_open', 'ready'), e('home', 'ready'),
        e('ready', 'repeat'),
        e('repeat', 'approach', 'repeat'), e('repeat', 'home_end', 'done'),
        e('approach', 'check'),
        e('check', 'pick', 'yes'), e('check', 'retry_wait', 'no'),
        e('pick', 'grip_close'), e('grip_close', 'lift'), e('lift', 'place'), e('place', 'release'), e('release', 'repeat'),
        e('retry_wait', 'repeat'),
      ],
    },
  },
]
