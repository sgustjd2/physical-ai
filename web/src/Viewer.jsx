// /robot_description(URDF)을 three.js로 그리고 매 프레임 /joint_states 최신값을 반영한다. 로봇이 바뀌어도 코드 그대로.
import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import URDFLoader from 'urdf-loader'
import { latest, robotDescription } from './ros'

export default function Viewer() {
  const ref = useRef()
  useEffect(() => {
    const el = ref.current
    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(devicePixelRatio)
    el.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(getComputedStyle(el).getPropertyValue('--viewer-bg').trim() || '#1c1f24')
    scene.add(new THREE.HemisphereLight(0xffffff, 0x404040, 2.2))
    const sun = new THREE.DirectionalLight(0xffffff, 1.6)
    sun.position.set(2, 4, 3)
    scene.add(sun)
    scene.add(new THREE.GridHelper(2, 20, 0x5a6270, 0x343a42))

    const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 50)
    camera.position.set(1.4, 1.0, 1.6)
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.target.set(0, 0.45, 0)

    let robot
    // ponytail: 기본 도형 URDF만 그려짐. package:// 메시는 메시 파일을 HTTP로 서빙하고 loader.packages 를 지정해야 함
    const onUrdf = (m) => {
      if (robot) scene.remove(robot)
      robot = new URDFLoader().parse(m.data)
      robot.rotation.x = -Math.PI / 2 // ROS는 Z-up, three.js는 Y-up
      scene.add(robot)
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
      cancelAnimationFrame(raf)
      ro.disconnect()
      controls.dispose()
      renderer.dispose()
      el.removeChild(renderer.domElement)
    }
  }, [])
  return <div ref={ref} className="viewer" />
}
