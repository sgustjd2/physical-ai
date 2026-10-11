// 3D 작업 셀: 로봇 프로파일의 scene 물체 → three.js 객체 (ROS 좌표계: Z 위쪽, 미터, rpy 라디안). scene3d.test.js로 확인.
// 파일(URDF 메시·작업 셀 STL/GLB)은 웹 서버의 /robots/<로봇>/… 에서 받는다 (운영: nginx 마운트, 개발: vite 플러그인)
import * as THREE from 'three'

export const robotsUrl = (robot) => `/robots/${encodeURIComponent(robot)}`
// URDF package://<pkg>/… → /robots/<robot>/<mesh_packages[pkg] ?? pkg>/…  (urdf-loader packages 함수)
export const packageResolver = (robot, packages = {}) => (pkg) => `${robotsUrl(robot)}/${packages[pkg] ?? pkg}`

const num = (v, d) => (v !== '' && v != null && Number.isFinite(Number(v)) ? Number(v) : d)
const vec3 = (a, d) => (Array.isArray(a) && a.length === 3 ? a.map((v, i) => num(v, d[i])) : d)

// 물체 하나 → Object3D. 메시는 loadMesh(url, done(object3d))로 나중에 붙는다. 모르는 shape는 null (프로파일 오타가 화면 전체를 깨지 않게)
export function sceneObject(o, robot, loadMesh) {
  const opacity = num(o.opacity, 1)
  const material = new THREE.MeshStandardMaterial({ color: o.color || '#8a8f98', roughness: 0.85, transparent: opacity < 1, opacity })
  let obj
  if (o.shape === 'box') {
    obj = new THREE.Mesh(new THREE.BoxGeometry(...vec3(o.size, [0.1, 0.1, 0.1])), material)
  } else if (o.shape === 'cylinder') {
    const r = num(o.radius, 0.05)
    const g = new THREE.CylinderGeometry(r, r, num(o.height, 0.1), 32)
    g.rotateX(Math.PI / 2) // three.js 원기둥은 Y축, ROS(URDF)는 Z축
    obj = new THREE.Mesh(g, material)
  } else if (o.shape === 'sphere') {
    obj = new THREE.Mesh(new THREE.SphereGeometry(num(o.radius, 0.05), 24, 16), material)
  } else if (o.shape === 'mesh' && o.file) {
    obj = new THREE.Group()
    const s = Array.isArray(o.scale) ? vec3(o.scale, [1, 1, 1]) : Array(3).fill(num(o.scale, 1))
    obj.scale.set(...s)
    const stl = /\.stl$/i.test(o.file)
    loadMesh(`${robotsUrl(robot)}/${o.file}`, (m) => {
      // STL은 재질이 없으니 color로, GLB는 color를 적었을 때만 덮어씀 (텍스처 보존)
      if (stl || o.color) m.traverse((c) => { if (c.isMesh) c.material = material })
      obj.add(m)
    })
  } else {
    return null
  }
  obj.name = o.name || o.shape
  obj.position.set(...vec3(o.xyz, [0, 0, 0]))
  const [roll, pitch, yaw] = vec3(o.rpy, [0, 0, 0])
  obj.rotation.set(roll, pitch, yaw, 'ZYX') // ROS rpy = Rz(yaw)·Ry(pitch)·Rx(roll)
  return obj
}
