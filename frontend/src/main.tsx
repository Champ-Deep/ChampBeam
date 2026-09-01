import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { ClerkProvider } from '@clerk/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Toaster } from 'sonner'
import { ConfirmProvider } from './components/ui/ConfirmDialog'
import App from './App'
import { initTheme } from './hooks/useTheme'
import './index.css'

// Theme the document before React mounts so the first paint is correct.
initTheme()

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000,
      retry: 1,
    },
  },
})

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
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <ConfirmProvider>
            <App />
          </ConfirmProvider>
          <Toaster position="top-right" duration={4000} />
        </BrowserRouter>
      </QueryClientProvider>
    </ClerkProvider>
  </React.StrictMode>,
)
