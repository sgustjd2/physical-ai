// 되돌리기/다시 하기 기록. 편집 동작마다 기록 코드를 넣지 않고, 그래프 상태(JSON 문자열)의 변화만 보고 단계를 나눈다.
//   - 드래그·타이핑처럼 연달아 오는 변화는 GAP(1초) 안이면 한 단계
//   - 노드·연결이 생기거나 지워지면(sig 변화) 그 변화만 한 단계: 앞뒤 묶음과 합치지 않음 (같은 동작의 연속 갱신 BURST 안은 한 단계)
// React와 무관한 순수 로직이라 history.test.js로 바로 확인한다.
const GAP = 1000
const BURST = 100

export function createHistory(initial, limit = 100) {
  let past = []
  let future = []
  let stable = initial // 지금 묶음이 시작되기 전 상태 (= 되돌리면 갈 곳)
  let last = initial // 가장 최근 상태
  let lastAt = -Infinity
  let lastSig = null
  let lastStructural = false

  const close = () => {
    if (last === stable) return
    past.push(stable)
    if (past.length > limit) past.shift()
    stable = last
  }

  return {
    get last() { return last },
    get canUndo() { return last !== stable || past.length > 0 },
    get canRedo() { return future.length > 0 },
    // 편집으로 상태가 바뀌었을 때 (되돌리기/다시 하기로 바뀐 것은 last와 같아서 무시됨)
    change(key, sig, now) {
      if (key === last) { lastSig = sig; return } // 첫 렌더·되돌린 상태도 구조(sig)는 기억해 둔다
      const idle = now - lastAt
      const structural = lastSig !== null && sig !== lastSig
      if (idle > GAP || ((structural || lastStructural) && idle > BURST)) close()
      last = key
      lastStructural = structural
      lastSig = sig
      lastAt = now
      future = []
    },
    undo() {
      if (last === stable) {
        if (!past.length) return null
        future.push(last)
        stable = past.pop()
      } else {
        future.push(last) // 아직 안 끝난 묶음(드래그 직후 등)도 한 단계로 되돌린다
      }
      last = stable
      lastAt = -Infinity
      return last
    },
    redo() {
      if (!future.length) return null // future가 있으면 last === stable (새 편집은 future를 비움)
      past.push(stable)
      stable = last = future.pop()
      lastAt = -Infinity
      return last
    },
  }
}
