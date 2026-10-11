import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 개발 서버에서도 운영(nginx, docker-compose의 robots 마운트)과 같이 /robots/<로봇>/… 로 URDF 메시·작업 셀 파일을 준다
const ROBOTS = fileURLToPath(new URL('../robots', import.meta.url))
const TYPES = { '.stl': 'model/stl', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.dae': 'model/vnd.collada+xml', '.yaml': 'text/yaml' }
const serveRobots = {
  name: 'serve-robots',
  configureServer(server) {
    server.middlewares.use('/robots', (req, res) => {
      const file = resolve(ROBOTS, '.' + decodeURIComponent(req.url.split('?')[0]))
      // 폴더 밖 경로 차단, 없는 파일은 404 (앱 페이지로 넘기면 STL 로더가 HTML을 메시로 읽음 — nginx도 404)
      if (!file.startsWith(ROBOTS + sep) || !existsSync(file) || !statSync(file).isFile()) {
        res.statusCode = 404
        return res.end()
      }
      res.setHeader('Content-Type', TYPES[extname(file).toLowerCase()] || 'application/octet-stream')
      createReadStream(file).pipe(res)
    })
  },
}

export default defineConfig({ plugins: [react(), serveRobots] })
