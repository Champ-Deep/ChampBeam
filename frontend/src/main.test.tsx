import { afterEach, expect, it, vi } from 'vitest'
import ReactDOM from 'react-dom/client'
import indexHtml from '../index.html?raw'

vi.mock('react-dom/client', () => ({ default: { createRoot: vi.fn(() => ({ render: vi.fn() })) } }))
vi.mock('./App', () => ({ default: () => null }))
vi.mock('./components/SessionScope', () => ({ SessionScope: () => null }))
vi.mock('./components/ui/ConfirmDialog', () => ({ ConfirmProvider: () => null }))
vi.mock('./hooks/useTheme', () => ({ initTheme: vi.fn() }))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

it.each([
  ['lakeb2b.com', true],
  ['share.lakeb2b.com', true],
  ['team.share.lakeb2b.com', true],
  ['localhost', false],
  ['champbeam.com', false],
  ['notlakeb2b.com', false],
  ['lakeb2b.com.example.org', false],
])('sets tab branding before mounting on %s', async (hostname, branded) => {
  vi.resetModules()
  const html = new DOMParser().parseFromString(indexHtml, 'text/html')
  document.head.innerHTML = html.head.innerHTML
  document.body.innerHTML = html.body.innerHTML
  vi.stubGlobal('window', { location: { hostname } })
  vi.mocked(ReactDOM.createRoot).mockImplementationOnce(() => {
    expect(document.querySelector('link[rel="icon"]')?.getAttribute('href')).toBe(
      branded ? '/lakeb2b-favicon.svg' : '/vite.svg',
    )
    expect(document.title).toBe(branded ? 'LakeB2B Share' : 'Champbeam')
    return { render: vi.fn(), unmount: vi.fn() }
  })

  await import('./main')

  expect(ReactDOM.createRoot).toHaveBeenCalledOnce()
})
