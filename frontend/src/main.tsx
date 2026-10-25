import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { ClerkProvider } from '@clerk/react'
import { SessionScope } from './components/SessionScope'
import { Toaster } from 'sonner'
import { ConfirmProvider } from './components/ui/ConfirmDialog'
import App from './App'
import { initTheme } from './hooks/useTheme'
import './index.css'
import './workspace.css'

const hostname = window.location.hostname
if (hostname === 'lakeb2b.com' || hostname.endsWith('.lakeb2b.com')) {
  document.querySelector('link[rel="icon"]')?.setAttribute('href', '/lakeb2b-favicon.svg')
  document.title = document.title.replace(/^Champbeam/, 'LakeB2B Share')
}

// Theme the document before React mounts so the first paint is correct.
initTheme()


const CLERK_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('#root element missing')

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <ClerkProvider
      publishableKey={CLERK_KEY}
      afterSignOutUrl="/"
      signInUrl="/sign-in"
      signUpUrl="/sign-up"
      signInFallbackRedirectUrl="/"
      signUpFallbackRedirectUrl="/"
    >
      <SessionScope>
        <BrowserRouter>
          <ConfirmProvider>
            <App />
          </ConfirmProvider>
          <Toaster position="top-right" duration={4000} />
        </BrowserRouter>
      </SessionScope>
    </ClerkProvider>
  </React.StrictMode>,
)
