// 디지털 트윈 뷰: /robot_description(URDF)을 three.js로 그리고 매 프레임 /joint_states 최신값을 반영한다.
// 반투명 '고스트'는 목표 자세(선택한 MoveJ 노드, 또는 실행 중 받은 이동 명령)를 겹쳐 보여 준다.
// 시뮬레이션 실행 중에는 트윈 팔(/sim)이 움직이고, 고스트는 그대로 있는 실제 로봇 위치를 보여 준다. 로봇이 바뀌어도 코드 그대로.
// 작업 셀(작업대·지그·상자 등)은 /robot_scene 으로 받아 같이 그리고, URDF·작업 셀의 메시 파일은 /robots/<로봇>/… 에서 받는다.
import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import URDFLoader from 'urdf-loader'
import { Icon } from './icons'
import { latest, robotDescription, robotScene } from './ros'
import { packageResolver, sceneObject } from './scene3d'

const HOME = { pos: [1.4, 1.0, 1.6], target: [0, 0.45, 0] }
const REACHED_DEG = 0.5

// ghost: { 관절이름: rad } | null  (명시 목표). followCommand: 명시 목표가 없을 때 실행 중 이동 명령을 고스트로
// replay: 녹화 재생 중 → 녹화한 자세를 그리고 실제 로봇은 반투명으로 (시뮬레이션과 같은 방식)
// plan: { waypoints: [{id, pose}], segments: [[from, to]] } (motionPlan.js) → 팔 끝이 지나는 길, selectedId: 표시를 키울 단계
export default function Viewer({ stale, ghost, followCommand, simRun, replay, large, plan, selectedId }) {
  const ref = useRef()
  const resetRef = useRef(() => {})
  const ghostRef = useRef(ghost)
  const followRef = useRef(followCommand)
  const simRef = useRef(simRun)
  const replayRef = useRef(replay)
  const planRef = useRef(plan)
  const selRef = useRef(selectedId)
  const [showPath, setShowPath] = useState(() => { try { return localStorage.getItem('viewer.path') !== '0' } catch { return true } })
  const showRef = useRef(showPath)
  const remainRef = useRef(null)
  const [robotName, setRobotName] = useState('')
  const [remain, setRemain] = useState(null) // 목표까지 남은 최대 각도(°), 목표 없으면 null
  const [warn, setWarn] = useState('') // 3D 설정 문제 (불러오지 못한 파일, 없는 팔 끝 링크)
  ghostRef.current = ghost
  followRef.current = followCommand
  simRef.current = simRun
  replayRef.current = replay
  planRef.current = plan
  selRef.current = selectedId
  showRef.current = showPath

  useEffect(() => {
    const el = ref.current
    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(devicePixelRatio)
    el.prepend(renderer.domElement)
    renderer.domElement.setAttribute('role', 'img')
    renderer.domElement.setAttribute('aria-label', '로봇 3D 뷰어')

    const scene = new THREE.Scene()
    scene.add(new THREE.HemisphereLight(0xffffff, 0x404040, 2.2))
    const sun = new THREE.DirectionalLight(0xffffff, 1.6)
    sun.position.set(2, 4, 3)
    scene.add(sun)
    const ghostMat = new THREE.MeshStandardMaterial({ transparent: true, opacity: 0.32, depthWrite: false })
    const pathMat = new THREE.LineBasicMaterial({ transparent: true, opacity: 0.9 })
    const markMat = new THREE.MeshBasicMaterial()
    const selMat = new THREE.MeshBasicMaterial()

    // 배경·그리드·고스트 색은 CSS 토큰에서 읽어 라이트/다크 테마를 따른다
    let grid
    let floor = 0 // 바닥 그리드 높이: 작업 셀이 있으면 가장 낮은 물체 아래 (작업대 윗면과 겹쳐 깜빡이지 않게)
    const theme = () => {
      const css = getComputedStyle(el)
      scene.background = new THREE.Color(css.getPropertyValue('--viewer-bg').trim())
      ghostMat.color.set(css.getPropertyValue('--accent').trim())
      pathMat.color.set(css.getPropertyValue('--accent').trim())
      markMat.color.set(css.getPropertyValue('--accent').trim())
      selMat.color.set(css.getPropertyValue('--text').trim())
      if (grid) scene.remove(grid)
      grid = new THREE.GridHelper(2, 20, css.getPropertyValue('--viewer-grid').trim(), css.getPropertyValue('--viewer-grid-sub').trim())
      grid.position.y = floor - 0.002
      scene.add(grid)
    }
    theme()
    const scheme = matchMedia('(prefers-color-scheme: dark)')
    scheme.addEventListener('change', theme)

    const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 50)
    const controls = new OrbitControls(camera, renderer.domElement)
    resetRef.current = () => {
      camera.position.set(...HOME.pos)
      controls.target.set(...HOME.target)
    }
    resetRef.current()

    // 3D 파일 불러오기 (STL / GLB·GLTF). 실패하면 뷰어에 알림
    const stl = new STLLoader()
    const gltf = new GLTFLoader()
    let gen = 0 // 다시 그릴 때마다 증가: 지난 빌드의 늦게 온 실패는 알리지 않음
    const failed = (url, g = gen) => (err) => { console.warn('3D 파일을 불러오지 못함', url, err); if (g === gen) setWarn(`3D 파일을 불러오지 못함: ${url.split('/').pop()}`) }
    const loadMesh = (url, done) => {
      if (/\.(glb|gltf)$/i.test(url)) gltf.load(url, (g) => done(g.scene), undefined, failed(url))
      else stl.load(url, (geom) => done(new THREE.Mesh(geom)), undefined, failed(url))
    }

    // 작업 셀: 로봇 기준(ROS Z 위쪽) 좌표 → 로봇과 같은 회전
    const cell = new THREE.Group()
    cell.rotation.x = -Math.PI / 2
    scene.add(cell)
    let info = null // { robot, packages, objects }
    let urdfText = null

    let robot
    let ghostBot
    // URDF 메시(package://…)는 /robots/<로봇>/… 에서. 메시는 나중에 도착하므로 고스트 색은 고스트용 로더가 직접 입힌다
    const urdfLoader = (forGhost, g) => {
      const l = new URDFLoader()
      if (info?.robot) l.packages = packageResolver(info.robot, info.packages)
      l.loadMeshCb = (path, manager, material, done) => {
        const finish = (mesh, err) => {
          if (err) failed(path, g)(err)
          if (forGhost) mesh?.traverse((o) => { if (o.isMesh) o.material = ghostMat })
          done(mesh, err)
        }
        if (/\.(glb|gltf)$/i.test(path)) new GLTFLoader(manager).load(path, (g) => finish(g.scene), undefined, (e) => finish(null, e))
        else l.defaultMeshLoader(path, manager, material, finish)
      }
      return l
    }
    // 경로 미리보기: 화면에 안 그리는 로봇 사본으로 순기구학(관절 각도 → 팔 끝 위치)을 계산한다
    let fkBot
    let tcp
    const path = new THREE.Group()
    scene.add(path)
    const tcpLink = (bot) => { // 팔 끝 = 루트에서 관절을 가장 많이 거친 끝 링크
      let best
      let depth = -1
      for (const link of Object.values(bot.links)) {
        if (link.children.some((c) => c.isURDFJoint)) continue
        let d = 0
        for (let p = link.parent; p; p = p.parent) if (p.isURDFJoint) d += 1
        if (d > depth) { best = link; depth = d }
      }
      return best
    }
    const tipAt = (pose) => {
      for (const [n, v] of Object.entries(pose)) fkBot.joints[n]?.setJointValue(v)
      fkBot.updateMatrixWorld(true)
      return tcp.getWorldPosition(new THREE.Vector3())
    }
    let built = {}
    const buildPath = () => {
      built = { plan: planRef.current, bot: fkBot, sel: selRef.current, show: showRef.current }
      for (const c of [...path.children]) { path.remove(c); c.geometry.dispose() }
      const p = planRef.current
      if (!fkBot || !tcp || !p || !showRef.current) return
      const byId = new Map(p.waypoints.map((w) => [w.id, w.pose]))
      const pts = []
      for (const [a, b] of p.segments) { // MoveJ는 관절 공간 보간 → 팔 끝은 곡선으로 지나감
        const A = byId.get(a)
        const B = byId.get(b)
        let prev = tipAt(A)
        for (let i = 1; i <= 24; i++) {
          const cur = tipAt(Object.fromEntries(Object.keys(A).map((k) => [k, A[k] + ((B[k] ?? A[k]) - A[k]) * (i / 24)])))
          pts.push(prev, cur)
          prev = cur
        }
      }
      if (pts.length) path.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), pathMat))
      for (const w of p.waypoints) {
        const sel = w.id === selRef.current
        const m = new THREE.Mesh(new THREE.SphereGeometry(sel ? 0.02 : 0.011, 16, 12), sel ? selMat : markMat)
        m.position.copy(tipAt(w.pose))
        path.add(m)
      }
    }

    const buildRobot = () => {
      if (!urdfText) return
      gen += 1
      setWarn('')
      if (robot) scene.remove(robot, ghostBot)
      robot = urdfLoader(false, gen).parse(urdfText)
      ghostBot = urdfLoader(true, gen).parse(urdfText)
      const fkLoader = new URDFLoader()
      fkLoader.loadMeshCb = (p, m, mat, done) => done(null) // 계산용이라 메시는 받지 않음
      fkBot = fkLoader.parse(urdfText)
      fkBot.rotation.x = -Math.PI / 2
      tcp = fkBot.links[info?.tcp] || tcpLink(fkBot) // 프로파일 tcp_link, 없으면 맨 끝 링크
      if (info?.tcp && !fkBot.links[info.tcp]) setWarn(`URDF에 팔 끝 링크 없음: ${info.tcp}`)
      ghostBot.traverse((o) => { if (o.isMesh) o.material = ghostMat })
      for (const r of [robot, ghostBot]) r.rotation.x = -Math.PI / 2 // ROS는 Z-up, three.js는 Y-up
      ghostBot.visible = false
      scene.add(robot, ghostBot)
      setRobotName(robot.robotName || '로봇')
      renderer.domElement.setAttribute('aria-label', `${robot.robotName || '로봇'} 3D 자세`)
    }
    // 메시 위치(/robot_scene)를 받은 뒤에 그린다. 실행기가 /robot_scene 을 안 보내면(예전 버전) 1.5초 뒤 그냥 그림
    let waitScene
    const onUrdf = (m) => {
      urdfText = m.data
      clearTimeout(waitScene)
      if (info) buildRobot()
      else waitScene = setTimeout(buildRobot, 1500)
    }
    robotDescription.subscribe(onUrdf)
    const onScene = (m) => {
      const meshKey = (x) => JSON.stringify([x?.robot, x?.packages, x?.tcp])
      const rebuild = meshKey(info) !== meshKey(JSON.parse(m.data))
      info = JSON.parse(m.data)
      setWarn('')
      for (const c of [...cell.children]) { cell.remove(c); c.traverse((o) => { o.geometry?.dispose(); o.material?.dispose?.() }) }
      for (const o of info.objects || []) {
        const obj = sceneObject(o, info.robot, loadMesh)
        if (obj) cell.add(obj)
      }
      cell.updateMatrixWorld(true)
      const box = new THREE.Box3().setFromObject(cell)
      floor = box.isEmpty() ? 0 : Math.min(0, box.min.y)
      if (grid) grid.position.y = floor - 0.002
      clearTimeout(waitScene)
      if (rebuild || !robot) buildRobot() // 로봇·메시 패키지 위치가 바뀌었을 때만 다시 (메시를 또 받지 않게)
    }
    robotScene.subscribe(onScene)

    const resize = () => {
      renderer.setSize(el.clientWidth, el.clientHeight, false) // CSS 크기는 app.css가 정함
      camera.aspect = el.clientWidth / Math.max(el.clientHeight, 1)
      camera.updateProjectionMatrix()
    }
    const ro = new ResizeObserver(resize)
    ro.observe(el)

    let raf
    const loop = () => {
      raf = requestAnimationFrame(loop)
      if (robot) {
        const rep = replayRef.current
        const sim = simRef.current || rep // 다른 자세를 그리고 실제 로봇은 고스트로
        for (const [n, v] of Object.entries(rep ? latest.replayJoints : sim ? latest.simJoints : latest.joints)) robot.joints[n]?.setJointValue(v)
        const target = sim ? latest.joints : ghostRef.current || (followRef.current ? latest.command : null)
        ghostBot.visible = !!target
        let worst = null
        if (target) {
          for (const [n, v] of Object.entries(target)) {
            ghostBot.joints[n]?.setJointValue(v)
            if (!sim && n in latest.joints) worst = Math.max(worst ?? 0, Math.abs(v - latest.joints[n]) * 180 / Math.PI)
          }
        }
        remainRef.current = sim ? -1 : worst
      }
      const b = built // 계획·선택·표시가 바뀌었거나 로봇을 새로 그렸으면 경로를 다시 계산 (매 프레임은 아님)
      if (b.plan !== planRef.current || b.bot !== fkBot || b.sel !== selRef.current || b.show !== showRef.current) buildPath()
      controls.update()
      renderer.render(scene, camera)
    }
    loop()
    // 남은 각도 표시는 5Hz면 충분 (매 프레임 React 갱신을 피함)
    const tick = setInterval(() => setRemain(remainRef.current == null ? null : Math.round(remainRef.current * 10) / 10), 200)

    return () => {
      clearTimeout(waitScene)
      robotDescription.unsubscribe(onUrdf)
      robotScene.unsubscribe(onScene)
      scheme.removeEventListener('change', theme)
      clearInterval(tick)
      cancelAnimationFrame(raf)
      ro.disconnect()
      controls.dispose()
      renderer.dispose()
      renderer.domElement.remove()
    }
  }, [])

  return (
    <div ref={ref} className={`viewer${stale ? ' stale' : ''}${large ? ' large' : ''}`}>
      <span className="viewer-chip">
        {stale ? (robotName ? '연결 끊김: 마지막으로 받은 자세' : '연결 대기 중') : robotName || '로봇 모델 수신 대기 중…'}
      </span>
      {(simRun || replay) && !stale && (
        <span className="viewer-legend sim">
          <span className="ghost-swatch" aria-hidden="true" />
          반투명: 실제 로봇 위치 (움직이지 않음)
          <b>{replay ? '녹화 재생 중' : '시뮬레이션 중'}</b>
        </span>
      )}
      {!simRun && !replay && remain != null && remain >= 0 && !stale && (
        <span className="viewer-legend">
          <span className="ghost-swatch" aria-hidden="true" />
          {ghost ? '선택한 단계의 목표 자세' : '명령 목표 자세'}
          <b className={remain <= REACHED_DEG ? 'reached' : ''}>{remain <= REACHED_DEG ? '도달' : `남은 각도 ${remain.toFixed(1)}°`}</b>
        </span>
      )}
      {warn && !stale && <span className="viewer-chip viewer-warn" role="status">{warn}</span>}
      <button className="icon-btn viewer-path" aria-pressed={showPath} aria-label="경로 보기"
        title="경로 보기: 동작 블록 사이로 팔 끝이 지나는 길 (점 = 각 동작의 목표, 큰 점 = 선택한 단계)"
        onClick={() => setShowPath((v) => { try { localStorage.setItem('viewer.path', v ? '0' : '1') } catch { /* 저장 불가 */ } return !v })}>
        <Icon name="route" />
      </button>
      <button className="icon-btn viewer-reset" onClick={() => resetRef.current()} aria-label="시점 초기화" title="시점 초기화">
        <Icon name="view" />
      </button>
    </div>
  )
}
