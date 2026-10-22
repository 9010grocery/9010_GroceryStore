import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './styles/screens.css'
import './styles/access.css'
import './styles/step3.css'
import './styles/step4.css'
import './styles/step5.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
