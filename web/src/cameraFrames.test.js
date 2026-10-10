// node src/cameraFrames.test.js — 카메라 프레임 변환 확인 (CI web 작업에서 실행)
import assert from 'node:assert/strict'
import { createFeeds, fromBase64, isImageType, rawToRgba } from './cameraFrames.js'

assert.deepEqual([...fromBase64(Buffer.from([0, 128, 255]).toString('base64'))], [0, 128, 255])

assert.ok(isImageType('sensor_msgs/msg/CompressedImage') && isImageType('sensor_msgs/Image'))
assert.ok(!isImageType('sensor_msgs/msg/CameraInfo') && !isImageType('std_msgs/msg/String'))

// 2×1 bgr8, 행 끝에 패딩 1바이트 (step 7) → RGBA로 바뀌고 패딩은 무시
const bgr = { width: 2, height: 1, step: 7, encoding: 'bgr8', data: Buffer.from([10, 20, 30, 40, 50, 60, 99]).toString('base64') }
assert.deepEqual([...rawToRgba(bgr)], [30, 20, 10, 255, 60, 50, 40, 255])

// mono8 2×2 (배열로 와도 됨)
assert.deepEqual([...rawToRgba({ width: 2, height: 2, step: 2, encoding: 'mono8', data: [0, 1, 2, 3] })].filter((_, i) => i % 4 === 0), [0, 1, 2, 3])

// rgba8 알파 유지, 16비트 깊이는 지원 안 함
assert.deepEqual([...rawToRgba({ width: 1, height: 1, step: 4, encoding: 'rgba8', data: [1, 2, 3, 4] })], [1, 2, 3, 4])
assert.equal(rawToRgba({ width: 1, height: 1, step: 2, encoding: '16UC1', data: [0, 0] }), null)

// 같은 카메라를 두 화면이 보면: 구독 1번, 디코딩 1번, 두 화면 모두에 같은 프레임
const opened = []
const open = (name, type, cb) => { const s = { name, cb, closed: false }; opened.push(s); return () => { s.closed = true } }
let decodes = 0
let closedImages = 0
const decode = async (m) => { decodes += 1; return { image: { id: m.id, close: () => { closedImages += 1 } }, width: 4, height: 3, info: '4×3' } }
const feeds = createFeeds(open, decode, () => 0)
const seenA = []
const seenB = []
const a = feeds.join('/cam', 'sensor_msgs/msg/CompressedImage', (f) => seenA.push(f.image.id))
const b = feeds.join('/cam', 'sensor_msgs/msg/CompressedImage', (f) => seenB.push(f.image.id))
assert.equal(opened.length, 1)
assert.equal(a.feed, b.feed)
await opened[0].cb({ id: 1 })
assert.deepEqual([seenA, seenB, decodes, closedImages], [[1], [1], 1, 0]) // 마지막 프레임은 들고 있음
assert.equal(a.feed.frames, 1)
// 나중에 여는 화면은 기다리지 않고 마지막 프레임부터 (디코딩·구독 추가 없음)
const seenLate = []
const late = feeds.join('/cam', 'sensor_msgs/msg/CompressedImage', (f) => seenLate.push(f.image.id))
assert.deepEqual([seenLate, decodes, opened.length], [[1], 1, 1])
late.leave()
// 한 화면이 닫혀도 다른 화면은 계속, 둘 다 닫히면 구독 해제
a.leave()
assert.equal(opened[0].closed, false)
await opened[0].cb({ id: 2 })
assert.deepEqual([seenA, seenB, closedImages], [[1], [1, 2], 1]) // 새 프레임이 오면 이전 프레임 정리
b.leave()
assert.equal(opened[0].closed, true)
assert.equal(closedImages, 2) // 마지막 화면이 닫히면 들고 있던 프레임도 정리
const fresh = []
feeds.join('/cam', 'sensor_msgs/msg/CompressedImage', (f) => fresh.push(f)).leave()
assert.deepEqual(fresh, []) // 다시 열면 새로 구독, 지난 프레임은 보여 주지 않음
assert.equal(feeds.count(), 0)
// 디코딩 중에 온 프레임은 건너뜀
let release
const slow = createFeeds(open, () => new Promise((r) => { release = () => r({ image: {}, width: 1, height: 1, info: '' }) }), () => 1000)
const c = slow.join('/slow', 'sensor_msgs/msg/Image', () => {})
const sub = opened.at(-1)
const first = sub.cb({})
await sub.cb({}) // 바쁨 → 무시
release()
await first
assert.equal(c.feed.frames, 1)
// 디코딩 오류는 통계에 남고 다음 프레임은 다시 시도
const bad = createFeeds(open, async () => { throw new Error('깨진 프레임') }, () => 0)
const d = bad.join('/bad', 'sensor_msgs/msg/Image', () => {})
await opened.at(-1).cb({})
assert.equal(d.feed.err, '깨진 프레임')

console.log('camera OK')
