// 진입점. 컴포넌트 파일과 분리해야 개발 중 핫 리로드가 루트를 다시 만들지 않는다
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ReactFlowProvider } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import './app.css'
import App from './App'

createRoot(document.getElementById('root')).render(
  <StrictMode><ReactFlowProvider><App /></ReactFlowProvider></StrictMode>,
)
