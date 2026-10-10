// 카메라 프레임 변환 (React와 무관 → cameraFrames.test.js로 확인). rosbridge는 uint8[]을 base64 글자로 보낸다.
export function fromBase64(s) {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export const isImageType = (t) => /^sensor_msgs\/(msg\/)?(Compressed)?Image$/.test(t)

const CHANNELS = { rgb8: 3, bgr8: 3, rgba8: 4, bgra8: 4, mono8: 1, '8UC1': 1, '8UC3': 3 }

// sensor_msgs/Image(원본) → 캔버스용 RGBA. 지원하지 않는 인코딩이면 null (16비트 깊이 영상 등)
export function rawToRgba({ width, height, step, encoding, data }) {
  const c = CHANNELS[encoding]
  if (!c) return null
  const src = typeof data === 'string' ? fromBase64(data) : Uint8Array.from(data)
  const bgr = encoding.startsWith('bgr')
  const out = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const s = y * step + x * c
      const d = (y * width + x) * 4
      if (c === 1) {
        out[d] = out[d + 1] = out[d + 2] = src[s]
      } else {
        out[d] = src[s + (bgr ? 2 : 0)]
        out[d + 1] = src[s + 1]
        out[d + 2] = src[s + (bgr ? 0 : 2)]
      }
      out[d + 3] = c === 4 ? src[s + 3] : 255
    }
  }
  return out
}
