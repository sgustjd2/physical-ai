// 카메라: 실시간 화면 + 연결 상태. AI 비전 판단이 무엇을 보는지 사람이 같이 보도록.
// 이미지 토픽을 rosbridge로 받아 캔버스에 그린다. 압축(JPEG/PNG)은 10fps, 원본 Image는 무거워서 2fps로 받는다.
import { useEffect, useRef, useState } from 'react'
import { Topic } from 'roslib'
import { fromBase64, isImageType, rawToRgba } from './cameraFrames'
import { Hint } from './Hint'
import { Icon } from './icons'
import { ros } from './ros'

const STALE = 3000 // 이만큼 프레임이 없으면 '신호 없음'

// ROS 네트워크의 이미지 토픽 목록. null = 아직 모름 (연결 전)
export function useImageTopics(connected) {
  const [list, setList] = useState(null)
  const refresh = () => ros.getTopics(
    (r) => setList(r.topics.map((name, i) => ({ name, type: r.types[i] })).filter((t) => isImageType(t.type))
      .sort((a, b) => a.name.localeCompare(b.name))),
    () => setList([]))
  useEffect(() => { if (connected) refresh() }, [connected])
  return [list, refresh]
}

// value '' = 기본 카메라(로봇 프로파일 camera_topic)
export function CameraSelect({ id, value, onChange, list, defaultTopic, onRefresh }) {
  return (
    <div className="row">
      <select id={id} name={id} value={value} onChange={(e) => onChange(e.target.value)} translate="no">
        <option value="">{defaultTopic ? `기본: ${defaultTopic}` : '기본 카메라 없음 (프로파일 camera_topic)'}</option>
        {(list || []).filter((t) => t.name !== defaultTopic).map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
        {value && list && !list.some((t) => t.name === value) && <option value={value}>{value} (없음)</option>}
      </select>
      <button type="button" className="icon-btn" onClick={onRefresh} aria-label="카메라 목록 새로고침" title="카메라 목록 새로고침">
        <Icon name="refresh" />
      </button>
    </div>
  )
}

const STATUS = {
  none: () => '카메라를 고르세요',
  missing: () => '토픽 없음: 카메라 드라이버가 실행 중인지 확인하세요',
  wait: () => '연결 중…',
  stale: () => '신호 없음: 3초 넘게 프레임이 오지 않습니다',
}

// list: 이미지 토픽 목록 (null = 아직 모름 → '토픽 없음'으로 단정하지 않음)
export function CameraView({ topic, list, compact }) {
  const canvas = useRef()
  const [st, setSt] = useState({ state: 'wait' })
  const type = list?.find((t) => t.name === topic)?.type
  const state = !topic ? 'none' : list && !type ? 'missing' : st.state

  useEffect(() => {
    setSt({ state: 'wait' })
    if (!topic || !type) return
    const compressed = type.endsWith('CompressedImage')
    const t = new Topic({ ros, name: topic, messageType: type, throttle_rate: compressed ? 100 : 500, queue_length: 1 })
    let frames = 0
    let last = 0
    let info = ''
    let err = ''
    let busy = 0 // 그리기 시작 시각 (0 = 쉬는 중)
    const fit = (c, w, h) => { if (c.width !== w || c.height !== h) { c.width = w; c.height = h } }
    const draw = async (m) => {
      const c = canvas.current
      // 이전 프레임을 그리는 중이면 건너뜀. 디코딩이 2초 넘게 안 끝나면(백그라운드 탭 등) 묶여 있지 않게 새 프레임을 받는다
      if (!c || (busy && performance.now() - busy < 2000)) return
      busy = performance.now()
      try {
        if (compressed) {
          const png = m.format?.includes('png')
          const bmp = await createImageBitmap(new Blob([fromBase64(m.data)], { type: png ? 'image/png' : 'image/jpeg' }))
          fit(c, bmp.width, bmp.height)
          c.getContext('2d').drawImage(bmp, 0, 0)
          info = `${bmp.width}×${bmp.height} · ${png ? 'PNG' : 'JPEG'}`
          bmp.close()
        } else {
          const px = rawToRgba(m)
          if (!px) throw new Error(`지원하지 않는 인코딩 ${m.encoding}`)
          fit(c, m.width, m.height)
          c.getContext('2d').putImageData(new ImageData(px, m.width, m.height), 0, 0)
          info = `${m.width}×${m.height} · 원본 ${m.encoding}`
        }
        frames += 1
        last = performance.now()
        err = ''
      } catch (e) {
        err = `화면을 그리지 못함: ${e.message}`
      } finally {
        busy = 0
      }
    }
    t.subscribe(draw)
    const start = performance.now()
    let prev = { frames: 0, at: start }
    // 상태는 1초에 한 번만 갱신 (프레임마다 다시 그리지 않게)
    const tick = setInterval(() => {
      const now = performance.now()
      const fps = ((frames - prev.frames) * 1000) / (now - prev.at)
      prev = { frames, at: now }
      if (err) setSt({ state: 'error', msg: err })
      else if (now - (last || start) > STALE) setSt({ state: 'stale' })
      else if (last) setSt({ state: 'live', text: `연결됨 · ${fps.toFixed(1)}fps · ${info}` })
    }, 1000)
    return () => { t.unsubscribe(draw); clearInterval(tick) }
  }, [topic, type])

  const text = state === 'live' ? st.text : state === 'error' ? st.msg : STATUS[state]()
  return (
    <figure className={`camera ${state}${compact ? ' compact' : ''}`}>
      <div className="camera-frame">
        <canvas ref={canvas} role="img" aria-label={topic ? `${topic} 실시간 화면` : '카메라 화면'} />
        {state !== 'live' && state !== 'stale' && <div className="camera-empty">{state === 'wait' ? '연결 중…' : '화면 없음'}</div>}
      </div>
      <figcaption className="camera-status" role="status"><span className="dot" aria-hidden="true" />{text}</figcaption>
    </figure>
  )
}

// 오른쪽 '카메라' 탭: 고른 카메라의 실시간 화면 (보기용, 블록 설정은 바꾸지 않음)
export function CameraPanel({ connected, defaultTopic }) {
  const [list, refresh] = useImageTopics(connected)
  const [sel, setSel] = useState('')
  return (
    <div className="camera-panel">
      <h2 className="sr-only">카메라</h2>
      <div className="field">
        <div className="field-head">
          <label className="field-label" htmlFor="camera-view">카메라</label>
          <Hint label="카메라 설명">
            AI 비전 판단 블록은 기본으로 로봇 프로파일의 camera_topic을 봅니다(블록마다 바꿀 수 있음). 여기서 고르는 것은 화면 보기용이라 블록 설정은 바뀌지 않습니다.
          </Hint>
        </div>
        <CameraSelect id="camera-view" value={sel} onChange={setSel} list={list} defaultTopic={defaultTopic} onRefresh={refresh} />
      </div>
      <CameraView topic={sel || defaultTopic} list={list} />
    </div>
  )
}
