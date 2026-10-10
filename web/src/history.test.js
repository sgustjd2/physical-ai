// node src/history.test.js — 되돌리기/다시 하기 단계 나누기 확인 (CI web 작업에서 실행)
import assert from 'node:assert/strict'
import { createHistory } from './history.js'

// 드래그(연속 위치 변화)는 한 단계, 노드 추가는 새 단계
let h = createHistory('A')
assert.equal(h.canUndo, false)
h.change('A1', 's1', 0) // 드래그 시작
h.change('A2', 's1', 50)
h.change('A3', 's1', 100) // 드래그 끝
h.change('B', 's2', 600) // 노드 추가 (구조 변화) → 드래그 묶음을 끊음
assert.equal(h.undo(), 'A3') // 추가 취소
assert.equal(h.undo(), 'A') // 드래그 전체 취소
assert.equal(h.undo(), null)
assert.equal(h.redo(), 'A3')
assert.equal(h.redo(), 'B')
assert.equal(h.redo(), null)

// 같은 동작 안의 연속 갱신(노드 삭제 + 연결 다시 잇기, 100ms 안)은 한 단계
h = createHistory('A')
h.change('B1', 's2', 0)
h.change('B2', 's3', 10)
assert.equal(h.undo(), 'A')

// 블록 추가 직후 값 수정: 추가와 수정은 따로 되돌린다
h = createHistory('A', 100)
h.change('A', 's1', 0) // 처음 렌더 (sig 기록)
h.change('B', 's2', 2000) // 추가
h.change('B5', 's2', 2300) // 0.3초 뒤 값 수정
assert.equal(h.undo(), 'B')
assert.equal(h.undo(), 'A')

// 타이핑: 1초 넘게 쉬면 다음 단계
h = createHistory('A')
h.change('A1', 's', 0)
h.change('A12', 's', 300)
h.change('A123', 's', 2000)
assert.equal(h.undo(), 'A12')
assert.equal(h.undo(), 'A')

// 되돌린 뒤 새로 편집하면 다시 하기 기록은 사라짐
h = createHistory('A')
h.change('B', 's2', 0)
h.undo()
assert.equal(h.canRedo, true)
h.change('C', 's3', 5000)
assert.equal(h.canRedo, false)
assert.equal(h.undo(), 'A')

// 되돌리기/다시 하기로 바뀐 상태가 change로 다시 들어와도 기록되지 않음
h = createHistory('A')
h.change('B', 's2', 0)
const k = h.undo()
h.change(k, 's1', 10)
assert.equal(h.canRedo, true)

// 기록 개수 제한
h = createHistory('0', 3)
for (let i = 1; i <= 6; i++) h.change(String(i), `s${i}`, i * 2000)
let n = 0
while (h.undo() !== null) n++
assert.equal(n, 4) // 제한 3 + 아직 열린 마지막 묶음 1

console.log('history OK')
