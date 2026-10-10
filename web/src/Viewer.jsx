// /robot_description(URDF)을 three.js로 그리고 매 프레임 /joint_states 최신값을 반영한다. 로봇이 바뀌어도 코드 그대로.
import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import URDFLoader from 'urdf-loader'
import { Icon } from './icons'
import { latest, robotDescription } from './ros'

const HOME = { pos: [1.4, 1.0, 1.6], target: [0, 0.45, 0] }

export default function Viewer({ stale }) {
  const ref = useRef()
  const resetRef = useRef(() => {})
  const [robotName, setRobotName] = useState('')

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

    // 배경·그리드 색은 CSS 토큰에서 읽어 라이트/다크 테마를 따른다
    let grid
    const theme = () => {
      const css = getComputedStyle(el)
      scene.background = new THREE.Color(css.getPropertyValue('--viewer-bg').trim())
      if (grid) scene.remove(grid)
      grid = new THREE.GridHelper(2, 20, css.getPropertyValue('--viewer-grid').trim(), css.getPropertyValue('--viewer-grid-sub').trim())
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

    let robot
    // ponytail: 기본 도형 URDF만 그려짐. package:// 메시는 메시 파일을 HTTP로 서빙하고 loader.packages 를 지정해야 함
    const onUrdf = (m) => {
      if (robot) scene.remove(robot)
      robot = new URDFLoader().parse(m.data)
      robot.rotation.x = -Math.PI / 2 // ROS는 Z-up, three.js는 Y-up
      scene.add(robot)
      setRobotName(robot.robotName || '로봇')
      renderer.domElement.setAttribute('aria-label', `${robot.robotName || '로봇'} 3D 자세`)
    }
    robotDescription.subscribe(onUrdf)

    const resize = () => {
      renderer.setSize(el.clientWidth, el.clientHeight)
      camera.aspect = el.clientWidth / Math.max(el.clientHeight, 1)
      camera.updateProjectionMatrix()
    }
    const ro = new ResizeObserver(resize)
    ro.observe(el)

    let raf
    const loop = () => {
      raf = requestAnimationFrame(loop)
      if (robot) for (const [n, v] of Object.entries(latest.joints)) robot.joints[n]?.setJointValue(v)
      controls.update()
      renderer.render(scene, camera)
    }
    loop()

    return () => {
      robotDescription.unsubscribe(onUrdf)
      scheme.removeEventListener('change', theme)
      cancelAnimationFrame(raf)
      ro.disconnect()
      controls.dispose()
      renderer.dispose()
      renderer.domElement.remove()
    }
  }, [])

  return (
    <div ref={ref} className={`viewer${stale ? ' stale' : ''}`}>
      <span className="viewer-chip">
        {stale ? (robotName ? '연결 끊김: 마지막으로 받은 자세' : '연결 대기 중') : robotName || '로봇 모델 수신 대기 중…'}
      </span>
      <button className="icon-btn viewer-reset" onClick={() => resetRef.current()} aria-label="시점 초기화" title="시점 초기화">
        <Icon name="view" />
      </button>
    </div>
  )
}
