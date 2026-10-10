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

// 같은 카메라를 여러 화면(카메라 탭·트윈 보기·블록 미리보기)이 볼 때 구독·디코딩은 한 번만 하고, 디코딩한 프레임을 모든 화면에 그린다.
// open(name, type, onMessage) → close(): 실제 구독 (Camera.jsx는 roslib Topic)
// decode(msg, type) → Promise<{ image, width, height, info }>: image는 ImageBitmap(close 가능) 또는 ImageData
// 디코딩이 끝나기 전에 온 프레임은 건너뛴다. 2초 넘게 안 끝나면(백그라운드 탭 등) 묶여 있지 않게 다음 프레임을 받는다
// 마지막 프레임은 들고 있다가, 나중에 같은 카메라를 여는 화면에 바로 그린다 (마지막 화면이 닫히면 버림 → 오래된 화면을 실시간처럼 보여 주지 않음)
export function createFeeds(open, decode, now = () => performance.now()) {
  const feeds = new Map()
  const start = (name, type) => {
    const f = { views: new Set(), frames: 0, last: 0, info: '', err: '', busy: 0, started: now(), latest: null }
    f.close = open(name, type, async (m) => {
      if (f.busy && now() - f.busy < 2000) return
      f.busy = now()
      try {
        const frame = await decode(m, type)
        for (const draw of f.views) draw(frame)
        f.latest?.image.close?.() // 이전 프레임 정리, 새 프레임은 들고 있음
        f.latest = frame
        f.frames += 1
        f.last = now()
        f.info = frame.info
        f.err = ''
      } catch (e) {
        f.err = e.message
      } finally {
        f.busy = 0
      }
    })
    feeds.set(name, f)
    return f
  }
  return {
    // 화면 하나가 카메라를 보기 시작 → { feed(통계: frames, last, info, err, started), leave() }
    join(name, type, draw) {
      const f = feeds.get(name) ?? start(name, type)
      f.views.add(draw)
      if (f.latest) draw(f.latest) // 이미 다른 화면이 보고 있던 카메라: 기다리지 않고 마지막 프레임부터
      return {
        feed: f,
        leave() {
          f.views.delete(draw)
          if (!f.views.size && feeds.get(name) === f) {
            f.close()
            f.latest?.image.close?.()
            f.latest = null
            feeds.delete(name)
          }
        },
      }
    },
    count: () => feeds.size,
  }
}
