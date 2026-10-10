// node src/cameraFrames.test.js — 카메라 프레임 변환 확인 (CI web 작업에서 실행)
import assert from 'node:assert/strict'
import { fromBase64, isImageType, rawToRgba } from './cameraFrames.js'

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

console.log('camera OK')
