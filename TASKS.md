# TASKS

## Phase 1 — MVP: 웹 + ROS2 + 모의 로봇팔
- [x] repo 초기화, GitHub 원격 연결
- [x] `ros/mock_arm.py` — 하드웨어 없이 개발용 모의 6축 팔 (`/joint_states` 발행 + `FollowJointTrajectory` 액션 서버)
- [x] `ros/workflow_executor.py` — 노드 그래프(JSON)를 받아 순서대로 실행, 상태를 `/workflow/status`로 발행
- [x] `ros/Dockerfile` + `bringup.launch.py` — ROS2 Jazzy + rosbridge (arm64/amd64 공용)
- [x] `web/` — React Flow 노드 에디터 + three.js URDF 3D 뷰어 + 토픽 모니터 + 조인트 조그
- [x] `docker-compose.yml` — GB10에서 `docker compose up` 한 번으로 전체 기동
- [x] 로컬 end-to-end 검증 (WSL + pixi/RoboStack ROS2: `smoke_test.py` 통과, 브라우저 실행/정지/조그/토픽 모니터 확인)
- [x] README (아키텍처, 실행법, 로드맵), 첫 커밋 & push
- [ ] GB10 실기에서 `docker compose up` 확인 (arm64 이미지 빌드, host 네트워크) — amd64 Docker 경로는 CI가 검증

## Phase 1.5 — 확장 구조 + 에피소드 녹화
- [x] 로봇 프로파일 `robots/<이름>/` (robot.yaml + URDF) — 로봇이 바뀌면 이 폴더만 추가, 코드 수정 없음
- [x] 웹은 로봇 무관하게: URDF를 `/robot_description` 토픽에서 받음 (web/public/robot.urdf 제거)
- [x] 노드 타입 플러그인 `ros/nodes/*.py` — 노드가 자기 UI 필드를 선언, 웹은 자동 생성 (새 노드 = 파이썬 파일 하나)
- [x] `ros/recorder.py` — rosbag2(mcap)로 에피소드 녹화, `data/episodes/<시간>_<작업>/` (bag + episode.json)
- [x] 워크플로 노드 `에피소드 시작/종료` + 실행이 끝나면 녹화 자동 종료, 이동 명령을 `/workflow/command`로 발행해 함께 기록
- [x] 웹 에피소드 패널 (작업 설명, 녹화 시작, 성공/실패로 종료, 최근 목록)
- [x] smoke_test에 녹화 검증 추가 + GitHub Actions CI (웹 빌드 + ROS 스모크 테스트)
- [x] README: 새 로봇 / 새 노드 타입 / 녹화 방법

## UI/UX — B2B 운영·시연 품질
- [x] 노드: 캔버스에는 요약만, 편집은 선택 시 인스펙터(실제 크기) — 기본 배율에서 글자 7px → 13px
- [x] 세로 흐름 + 자동 정렬, 선택한 노드 뒤에 끼워 넣기, 중간 노드 삭제 시 앞뒤 자동 연결
- [x] 드래그 없이 연결: 인스펙터 '다음 단계' 선택 (키보드·터치 대안, WCAG 2.2)
- [x] 노드 분류(플러그인 GROUP)별 팔레트 묶음 + 분류 색
- [x] 헤더: 시스템 상태(연결·실행기·녹화기·관절 Hz), 단계 진행 막대, 사이클 타임, 녹화 표시
- [x] 연결 끊김 배너(한 줄 + ⓘ 툴팁), 뷰어 '마지막 자세' 표시
- [x] 문서 툴바: 워크플로 이름, 단계 수, 정렬/새로 만들기/불러오기/내보내기 (덮어쓰기·삭제는 되돌리기)
- [x] 라이트/다크(OS 따름) 토큰, 대비 4.5:1 이상, 터치 기기 44px, 실행=초록/정지=빨강
- [x] 접근성: 건너뛰기 링크, 탭(ARIA), 상태 알림 영역, 아이콘 SVG 통일, 움직임 줄이기
- [ ] 메시(package://) URDF 서빙 후 3D 뷰어 확인
- [ ] 와이드 모니터(1920+)에서 육안 확인 (이번엔 패널이 좁아 DOM 측정으로만 확인)

## Phase 2 — 실제 현장 투입
- [ ] 개발용 저가 팔(SO-101 / ROBOTIS OMX)로 실물 루프 먼저 검증 — mock_arm 다음 단계, 산업용 팔 전에 리스크 낮추기
- [ ] 실제 로봇팔 드라이버 연동 (제조사 ROS2 드라이버 → `trajectory_action` 파라미터만 교체)
- [ ] 제조사 URDF/메시 로드 (`/robot_description` 구독 + 메시 서빙)
- [ ] 작업물(GLB/STL) 3D 씬 배치, 실행 전 궤적 "고스트" 미리보기
- [ ] 워크플로 서버 저장 (지금은 JSON 내보내기/불러오기만)
- [ ] 분기 노드 (if/else), MoveL(직선 이동, MoveIt2 필요)

## Phase 3 — Physical AI 데이터 루프 (수집 → 학습 → 실행)
참고: 패스트캠퍼스 "Physical AI 로봇 제어 올인원" 커리큘럼 (Isaac Sim → ROS2 텔레옵 → 데이터 수집 → LeRobot/SmolVLA)
- [ ] rosbag → LeRobot Dataset v3 변환 (`ai/convert_lerobot.py`)
  - [ ] 로봇 프로파일 `dataset` 섹션: 관절, 카메라 매핑, action 정의 (next_state | 토픽)
  - [ ] ROS 없이 mcap 직접 읽기 (mcap-ros2-support), fps 리샘플링(직전값 유지), 카메라 Image/CompressedImage
  - [ ] 결과 필터(기본 success), 출처 기록(conversion.json)
  - [ ] 테스트: 합성 bag(관절+카메라) 변환 → LeRobotDataset 로드 검증, 실제 녹화 bag 변환 (CI)
  - [ ] `ai/` Docker 이미지 + compose `tools` 프로파일, README
- [ ] Replayer로 관측·행동 검증
- [ ] Rerun으로 에피소드 시간축 확인 (웹에 Rerun 뷰어 임베드)
- [ ] 리더-팔로워 텔레옵 (리더 팔로 시연 → 팔로워/실제 팔) — 데모 수집 입력 장치
- [ ] **VLA 정책 노드**: 워크플로 안에서 "자연어 지시 → SmolVLA 등 정책 실행 (타임아웃/성공 조건)". 정해진 MoveJ 단계와 학습된 스킬 단계를 한 그래프에서 섞음. 추론은 GB10 GPU
- [ ] 카메라 내·외부 파라미터 캘리브레이션 + TF tree를 3D 뷰어에 표시
- [ ] Isaac Sim 장면(OpenUSD) + 도메인 랜덤화로 합성 데이터 생성 (GB10 aarch64는 DGX Spark 계열만 지원, 기능 제한·RTX 초기화 크래시 보고 있음 → 실기 확인 필요)
- [ ] MoveIt2 연동 (충돌 회피 경로 계획)
- [ ] Blender 브리지 (rosbridge 웹소켓 → Blender 아마추어 구동, 고품질 씬/오프라인 시뮬)
