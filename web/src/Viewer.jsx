// URDF 로봇을 three.js로 그리고 매 프레임 /joint_states 최신값을 반영한다.
import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import URDFLoader from 'urdf-loader'
import { latest } from './ros'

// ponytail: 정적 URDF(public/robot.urdf). 실제 팔은 제조사 URDF로 교체하거나 /robot_description 구독으로 바꿀 것
const URDF_URL = '/robot.urdf'

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
    new URDFLoader().load(URDF_URL, (r) => {
      robot = r
      r.rotation.x = -Math.PI / 2 // ROS는 Z-up, three.js는 Y-up
      scene.add(r)
    })

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
      cancelAnimationFrame(raf)
      ro.disconnect()
      controls.dispose()
      renderer.dispose()
      el.removeChild(renderer.domElement)
    }
  }, [])
  return <div ref={ref} className="viewer" />
}
