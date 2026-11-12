import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { startRum } from './monitoring/rum.ts'

// Monitoring is operationally useful but should never compete with the map's
// first render for network, parsing or main-thread time.
const requestIdle = Reflect.get(window, 'requestIdleCallback') as typeof window.requestIdleCallback | undefined
if (requestIdle) requestIdle.call(window, () => startRum(), { timeout: 5000 })
else globalThis.setTimeout(startRum, 2500)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
