// 카메라: 실시간 화면 + 연결 상태. AI 비전 판단이 무엇을 보는지 사람이 같이 보도록.
// 이미지 토픽을 rosbridge로 받아 캔버스에 그린다. 압축(JPEG/PNG)은 10fps, 원본 Image는 무거워서 2fps로 받는다.
// 같은 카메라를 여러 화면이 보면 구독·디코딩은 한 번만 하고 나눠 그린다 (createFeeds)
import { useEffect, useRef, useState } from 'react'
import { Topic } from 'roslib'
import { createFeeds, fromBase64, isImageType, rawToRgba } from './cameraFrames'
import { Hint } from './Hint'
import { Icon } from './icons'
import { ros } from './ros'

const STALE = 3000 // 이만큼 프레임이 없으면 '신호 없음'

const feeds = createFeeds(
  (name, type, onMessage) => {
    const t = new Topic({ ros, name, messageType: type, throttle_rate: type.endsWith('CompressedImage') ? 100 : 500, queue_length: 1 })
    t.subscribe(onMessage)
    return () => t.unsubscribe(onMessage)
  },
  async (m, type) => {
    if (type.endsWith('CompressedImage')) {
      const png = m.format?.includes('png')
      const image = await createImageBitmap(new Blob([fromBase64(m.data)], { type: png ? 'image/png' : 'image/jpeg' }))
      return { image, width: image.width, height: image.height, info: `${image.width}×${image.height} · ${png ? 'PNG' : 'JPEG'}` }
    }
    const px = rawToRgba(m)
    if (!px) throw new Error(`지원하지 않는 인코딩 ${m.encoding}`)
    return { image: new ImageData(px, m.width, m.height), width: m.width, height: m.height, info: `${m.width}×${m.height} · 원본 ${m.encoding}` }
  },
)

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
export function CameraSelect({ id, value, onChange, list, defaultTopic, onRefresh, label }) {
  return (
    <div className="row">
      <select id={id} name={id} value={value} onChange={(e) => onChange(e.target.value)} translate="no" aria-label={label}>
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
    const draw = ({ image, width, height }) => {
      const c = canvas.current
      if (!c) return
      if (c.width !== width || c.height !== height) { c.width = width; c.height = height }
      const g = c.getContext('2d')
      if (image instanceof ImageData) g.putImageData(image, 0, 0)
      else g.drawImage(image, 0, 0)
    }
    const { feed, leave } = feeds.join(topic, type, draw)
    // 이미 다른 화면이 보고 있던 카메라면 마지막 프레임과 상태를 바로 (fps는 1초 뒤 갱신)
    if (feed.last && performance.now() - feed.last < STALE) setSt({ state: 'live', text: `연결됨 · ${feed.info}` })
    let prev = { frames: feed.frames, at: performance.now() }
    // 상태는 1초에 한 번만 갱신 (프레임마다 다시 그리지 않게). 통계는 같은 카메라를 보는 화면끼리 공유
    const tick = setInterval(() => {
      const now = performance.now()
      const fps = ((feed.frames - prev.frames) * 1000) / (now - prev.at)
      prev = { frames: feed.frames, at: now }
      if (feed.err) setSt({ state: 'error', msg: `화면을 그리지 못함: ${feed.err}` })
      else if (now - (feed.last || feed.started) > STALE) setSt({ state: 'stale' })
      else if (feed.last) setSt({ state: 'live', text: `연결됨 · ${fps.toFixed(1)}fps · ${feed.info}`, said: '연결됨' })
    }, 1000)
    return () => { leave(); clearInterval(tick) }
  }, [topic, type])

  const text = state === 'live' ? st.text : state === 'error' ? st.msg : STATUS[state]()
  return (
    <figure className={`camera ${state}${compact ? ' compact' : ''}`}>
      <div className="camera-frame">
        <canvas ref={canvas} role="img" aria-label={topic ? `${topic} 실시간 화면` : '카메라 화면'} />
        {state !== 'live' && state !== 'stale' && <div className="camera-empty">{state === 'wait' ? '연결 중…' : '화면 없음'}</div>}
      </div>
      {/* 보이는 글은 fps까지, 읽어 주는 글(role=status)은 상태만 — fps가 바뀔 때마다 읽지 않게 */}
      <figcaption className="camera-status"><span className="dot" aria-hidden="true" /><span aria-hidden="true">{text}</span>
        <span className="sr-only" role="status">{state === 'live' ? st.said : text}</span>
      </figcaption>
    </figure>
  )
}

// 고른 카메라의 실시간 화면 (보기용, 블록 설정은 바꾸지 않음). 오른쪽 '카메라' 탭과 트윈 보기의 오른쪽 위 칸에서 쓴다.
// value/onChange: 고른 카메라 ('' = 기본). App이 들고 있어 두 곳이 같은 카메라를 보고, 새로고침해도 유지된다
// bare: 이름·도움말 줄 없이 카메라 선택만 (트윈 보기처럼 화면에 높이를 더 줄 때)
export function CameraPanel({ id = 'camera-view', connected, defaultTopic, value, onChange, bare }) {
  const [list, refresh] = useImageTopics(connected)
  const select = <CameraSelect id={id} value={value} onChange={onChange} list={list} defaultTopic={defaultTopic} onRefresh={refresh} label={bare ? '카메라 선택' : undefined} />
  return (
    <div className="camera-panel">
      <h2 className="sr-only">카메라</h2>
      {bare ? select : (
        <div className="field">
          <div className="field-head">
            <label className="field-label" htmlFor={id}>카메라</label>
            <Hint label="카메라 설명">
              AI 비전 판단 블록은 기본으로 로봇 프로파일의 camera_topic을 봅니다(블록마다 바꿀 수 있음). 여기서 고르는 것은 화면 보기용이라 블록 설정은 바뀌지 않습니다.
            </Hint>
          </div>
          {select}
        </div>
      )}
      <CameraView topic={value || defaultTopic} list={list} />
    </div>
  )
}
