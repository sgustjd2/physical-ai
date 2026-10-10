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
- [ ] GB10 실기에서 `docker compose up` 확인 (arm64 이미지 빌드, host 네트워크)

## Phase 2 — 실제 현장 투입
- [ ] 개발용 저가 팔(SO-101 / ROBOTIS OMX)로 실물 루프 먼저 검증 — mock_arm 다음 단계, 산업용 팔 전에 리스크 낮추기
- [ ] 실제 로봇팔 드라이버 연동 (제조사 ROS2 드라이버 → `trajectory_action` 파라미터만 교체)
- [ ] 제조사 URDF/메시 로드 (`/robot_description` 구독 + 메시 서빙)
- [ ] 작업물(GLB/STL) 3D 씬 배치, 실행 전 궤적 "고스트" 미리보기
- [ ] 워크플로 서버 저장 (지금은 JSON 내보내기/불러오기만)
- [ ] 분기 노드 (if/else), MoveL(직선 이동, MoveIt2 필요)

## Phase 3 — Physical AI 데이터 루프 (수집 → 학습 → 실행)
참고: 패스트캠퍼스 "Physical AI 로봇 제어 올인원" 커리큘럼 (Isaac Sim → ROS2 텔레옵 → 데이터 수집 → LeRobot/SmolVLA)
- [ ] 에피소드 녹화: 워크플로 실행/텔레옵 중 `/joint_states`·카메라·명령을 타임스탬프 동기화해 기록 (rosbag2) — 워크플로 시작/끝 = 에피소드 경계
- [ ] rosbag → LeRobot Dataset v3 변환, Replayer로 관측·행동 검증
- [ ] Rerun으로 에피소드 시간축 확인 (웹에 Rerun 뷰어 임베드)
- [ ] 리더-팔로워 텔레옵 (리더 팔로 시연 → 팔로워/실제 팔) — 데모 수집 입력 장치
- [ ] **VLA 정책 노드**: 워크플로 안에서 "자연어 지시 → SmolVLA 등 정책 실행 (타임아웃/성공 조건)". 정해진 MoveJ 단계와 학습된 스킬 단계를 한 그래프에서 섞음. 추론은 GB10 GPU
- [ ] 카메라 내·외부 파라미터 캘리브레이션 + TF tree를 3D 뷰어에 표시
- [ ] Isaac Sim 장면(OpenUSD) + 도메인 랜덤화로 합성 데이터 생성 (GB10 aarch64는 DGX Spark 계열만 지원, 기능 제한·RTX 초기화 크래시 보고 있음 → 실기 확인 필요)
- [ ] MoveIt2 연동 (충돌 회피 경로 계획)
- [ ] Blender 브리지 (rosbridge 웹소켓 → Blender 아마추어 구동, 고품질 씬/오프라인 시뮬)
