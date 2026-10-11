// node src/recovery.test.js — 운영 화면 조치 안내 (CI web 작업에서 실행)
import assert from 'node:assert/strict'
import { recoveryGuide } from './recovery.js'

const g = (state, msg, estop = false, mode = 'real') => recoveryGuide({ state, msg, estop, mode })
assert.equal(g('idle', ''), null)
assert.equal(g('done', ''), null)
assert.equal(g('error', 'x', true).title, '비상정지 중입니다') // 비상정지가 먼저
assert.deepEqual(g('stopped', '').actions, ['home'])
assert.deepEqual(g('stopped', '', false, 'sim').actions, []) // 시뮬레이션 정지에 실제 팔 홈 이동을 권하지 않음

// 실행기 오류 문구(ros/nodes) → 원인·할 일·바로가기, 원문은 예외 이름을 빼고 보여 줌
const r = g('error', 'RuntimeError: 너무 빠름(joint2): 이동 시간을 0.8초 이상으로')
assert.equal(r.todo, '편집에서 이 단계의 이동 시간을 0.8초 이상으로 늘리세요')
assert.equal(r.detail, '너무 빠름(joint2): 이동 시간을 0.8초 이상으로')
assert.deepEqual(r.actions, ['edit'])
assert.equal(g('error', 'RuntimeError: joint1 200°: 범위(-180~180°) 밖').title, '관절 목표가 로봇 범위를 벗어났습니다')
assert.equal(g('error', 'RuntimeError: 카메라 토픽 없음: /cam (로봇 프로파일의 camera_topic 확인)').title, '카메라 영상을 받지 못했습니다') // 토픽 없음보다 카메라
assert.equal(g('error', 'RuntimeError: 토픽 없음: /plc/ready').title, '장비 신호(토픽)를 찾지 못했습니다')
assert.equal(g('error', 'TimeoutError: 5초 시간 초과').title, '기다리던 신호가 오지 않았습니다')
assert.equal(g('error', 'RuntimeError: AI가 확신하지 못함: 흐림').title, 'AI가 판단을 확신하지 못해 멈췄습니다')
assert.equal(g('error', 'RuntimeError: AI 인증 실패: GB10의 .env에 ANTHROPIC_API_KEY를 확인하세요').title, 'AI 판단을 쓸 수 없습니다')
assert.equal(g('error', 'RuntimeError: 로봇팔 액션 서버 응답 없음').title, '로봇팔이 명령을 받지 않습니다')
assert.equal(g('error', 'RuntimeError: 시뮬레이션 팔 응답 없음').title, '디지털 트윈 팔이 응답하지 않습니다') // 로봇팔 규칙과 안 섞임
assert.equal(g('error', 'RuntimeError: 재생할 데이터셋 에피소드 없음: x #0').title, '재생할 녹화 데이터가 없습니다')
assert.deepEqual(g('error', 'KeyError: 뭔가 새로운 오류'),
  { title: '실행 중 오류가 났습니다', todo: '아래 메시지를 확인하고 문제 단계를 편집에서 보세요', detail: '뭔가 새로운 오류', actions: ['edit'] })

console.log('recovery OK')
