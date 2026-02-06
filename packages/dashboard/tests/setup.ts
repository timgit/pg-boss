import '@testing-library/jest-dom/vitest'
import { vi } from 'vitest'

// Mock matchMedia for theme provider tests
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
})

// Mock react-router hooks that require a data router context
// These are used by components like Sidebar that need useRouteLoaderData
vi.mock('react-router', async () => {
  const actual = await vi.importActual('react-router')
  return {
    ...actual,
    useRouteLoaderData: vi.fn(() => ({
      databases: [{ id: 'default', name: 'Default DB', url: 'postgres://...', schema: 'pgboss' }],
      currentDb: { id: 'default', name: 'Default DB', url: 'postgres://...', schema: 'pgboss' },
    })),
    useSearchParams: vi.fn(() => [new URLSearchParams(), vi.fn()]),
    useNavigate: vi.fn(() => vi.fn()),
  }
})
