// 시연·온보딩용 예제 워크플로. '열기' 메뉴에서 불러온다 (서버 저장소와 별개, 읽기 전용).
// 병렬 초기화 → 합류 → 3회 반복 { 접근 → 부품 감지 분기 → (예) 집기·옮기기·놓기 / (아니오) 잠시 대기 } → 홈
const mj = (id, x, y, joints) => ({ id, type: 'move_j', position: { x, y }, data: { joints, duration: 1.2 } })
const e = (source, target, sourceHandle) => ({ id: `${source}-${sourceHandle || 'out'}-${target}`, source, target, ...(sourceHandle ? { sourceHandle } : {}) })
const HOME = [0, 0, 0, 0, 0, 0]

export const EXAMPLES = [
  {
    name: '예제: 픽앤플레이스 (분기·병렬·반복)',
    graph: {
      nodes: [
        { id: 'start', type: 'start', position: { x: 70, y: 0 }, data: {} },
        { id: 'grip_open', type: 'gripper', position: { x: -134, y: 80 }, data: { action: '열기', settle: 0.5 } },
        mj('home', 134, 80, HOME),
        { id: 'ready', type: 'join', position: { x: 50, y: 200 }, data: {} },
        { id: 'repeat', type: 'loop', position: { x: 0, y: 280 }, data: { count: 3 } },
        mj('approach', -134, 400, [40, 35, 70, 0, 60, 0]),
        mj('home_end', 134, 400, HOME),
        { id: 'check', type: 'if', position: { x: -134, y: 510 }, data: { topic: '/sensor/part_present', op: '==', value: 'true', field: 'data', timeout: 5, sim_result: '예' } },
        { id: 'grip_close', type: 'gripper', position: { x: -268, y: 650 }, data: { action: '닫기', settle: 0.5 } },
        { id: 'retry_wait', type: 'wait', position: { x: 0, y: 650 }, data: { sec: 1 } },
        mj('place', -268, 760, [-40, 35, 70, 0, 60, 0]),
        { id: 'release', type: 'gripper', position: { x: -268, y: 880 }, data: { action: '열기', settle: 0.5 } },
      ],
      edges: [
        e('start', 'grip_open'), e('start', 'home'),
        e('grip_open', 'ready'), e('home', 'ready'),
        e('ready', 'repeat'),
        e('repeat', 'approach', 'repeat'), e('repeat', 'home_end', 'done'),
        e('approach', 'check'),
        e('check', 'grip_close', 'yes'), e('check', 'retry_wait', 'no'),
        e('grip_close', 'place'), e('place', 'release'), e('release', 'repeat'),
        e('retry_wait', 'repeat'),
      ],
    },
  },
]
