// node src/scene3d.test.js — 작업 셀 물체 변환 확인 (CI web 작업에서 실행)
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { packageResolver, sceneObject } from './scene3d.js'

const near = (a, b) => Math.abs(a - b) < 1e-6
const size = (obj) => new THREE.Box3().setFromObject(obj).getSize(new THREE.Vector3())

// URDF package:// 경로
const res = packageResolver('demo_arm', { demo_arm: '.' })
assert.equal(res('demo_arm'), '/robots/demo_arm/.')
assert.equal(res('ur_description'), '/robots/demo_arm/ur_description') // 적지 않으면 패키지 이름 폴더

// 상자: 크기·위치·색, 반투명
const box = sceneObject({ name: '작업대', shape: 'box', size: [1.2, 0.8, 0.04], xyz: [0.3, 0, -0.02], color: '#8a7a62', opacity: 0.5 }, 'demo_arm')
const s = size(box)
assert.ok(near(s.x, 1.2) && near(s.y, 0.8) && near(s.z, 0.04), s)
assert.deepEqual(box.position.toArray(), [0.3, 0, -0.02])
assert.equal(box.material.color.getHexString(), '8a7a62')
assert.ok(box.material.transparent && box.material.opacity === 0.5)
assert.equal(box.name, '작업대')

// 원기둥은 ROS처럼 Z축 방향 (three.js 기본 Y축이 아님)
const cyl = sceneObject({ shape: 'cylinder', radius: 0.02, height: 0.3 }, 'demo_arm')
assert.ok(near(size(cyl).z, 0.3) && near(size(cyl).x, 0.04), size(cyl))

// rpy: yaw 90°면 x로 긴 상자가 y로 길어짐, roll 90°면 y로 긴 상자가 z로
const yawed = sceneObject({ shape: 'box', size: [0.4, 0.1, 0.1], rpy: [0, 0, Math.PI / 2] }, 'r')
yawed.updateMatrixWorld()
assert.ok(near(size(yawed).y, 0.4) && near(size(yawed).x, 0.1), size(yawed))
const rolled = sceneObject({ shape: 'box', size: [0.1, 0.4, 0.1], rpy: [Math.PI / 2, 0, 0] }, 'r')
rolled.updateMatrixWorld()
assert.ok(near(size(rolled).z, 0.4), size(rolled))

// 메시: 로봇 폴더 기준 URL로 불러오고, STL은 색을 입힘. 배율
let asked
const mesh = sceneObject({ shape: 'mesh', file: 'meshes/fixture.stl', scale: 0.001, color: '#5f6b77' }, 'demo_arm', (url, done) => {
  asked = url
  done(new THREE.Mesh(new THREE.BoxGeometry(100, 100, 100)))
})
assert.equal(asked, '/robots/demo_arm/meshes/fixture.stl')
assert.ok(near(size(mesh).x, 0.1), size(mesh)) // 100 mm × 0.001
assert.equal(mesh.children[0].material.color.getHexString(), '5f6b77')

// 모르는 모양·파일 없는 메시는 무시 (프로파일 오타가 3D 전체를 깨지 않게), 잘못된 숫자는 기본값
assert.equal(sceneObject({ shape: 'cone' }, 'r'), null)
assert.equal(sceneObject({ shape: 'mesh' }, 'r'), null)
assert.ok(near(size(sceneObject({ shape: 'box', size: ['x', 0.2, 0.3] }, 'r')).x, 0.1))

console.log('scene3d OK')
