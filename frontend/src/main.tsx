import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { LazyMotion, MotionConfig, domAnimation } from 'motion/react'
import './index.css'
import App from './App'
import { installScrollbarFallback } from './utils/scrollbarFallback'

// Before the first paint: Firefox and Waterfox ignore the `::-webkit-scrollbar`
// rules in index.css and would otherwise show the platform scrollbar.
installScrollbarFallback()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <LazyMotion features={domAnimation} strict>
      <MotionConfig reducedMotion="user">
        <App />
      </MotionConfig>
    </LazyMotion>
  </StrictMode>,
)
