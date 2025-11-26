import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// Some third-party instrumentation assumes document.classList exists; provide a no-op shim to prevent runtime errors.
if (typeof document !== 'undefined' && !(document as any).classList) {
  const emptyClassList = {
    length: 0,
    add() {},
    remove() {},
    contains() {
      return false
    },
    toggle() {
      return false
    },
    item() {
      return null
    },
    forEach() {},
    toString() {
      return ''
    },
    [Symbol.iterator]: function* () {
      /* no-op */
    },
  }
  Object.defineProperty(document, 'classList', { value: emptyClassList, configurable: true })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
