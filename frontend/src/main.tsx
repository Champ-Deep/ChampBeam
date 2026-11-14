import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { SessionScope } from './components/SessionScope'
import { Toaster } from './components/ui/sonner'
import { ConfirmProvider } from './components/ui/ConfirmDialog'
import App from './App'
import { initTheme } from './hooks/useTheme'
import './index.css'
import './workspace.css'

const hostname = window.location.hostname
if (hostname === 'lakeb2b.com' || hostname.endsWith('.lakeb2b.com')) {
  document.querySelector('link[rel="icon"]')?.setAttribute('href', '/lakeb2b-favicon.svg')
  document.title = document.title.replace(/^Champbeam/, 'LakeB2B Share')
  const ogTitle = document.querySelector('meta[property="og:title"]')
  if (ogTitle) ogTitle.setAttribute('content', (ogTitle.getAttribute('content') ?? '').replace(/^Champbeam/, 'LakeB2B Share'))
}

// Theme the document before React mounts so the first paint is correct.
initTheme()

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('#root element missing')

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <SessionScope>
      <BrowserRouter>
        <ConfirmProvider>
          <App />
        </ConfirmProvider>
        <Toaster position="top-right" duration={4000} />
      </BrowserRouter>
    </SessionScope>
  </React.StrictMode>,
)
