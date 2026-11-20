import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach, vi } from 'vitest'

// jsdom has no matchMedia: every query reads as not matching, which is the full 1440×900 layout
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }),
})

afterEach(() => cleanup())

// jsdom cannot lay out xterm.js: the terminal views get a stand-in that keeps what is written to it
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80
    rows = 24
    written = ''
    loadAddon() {}
    open() {}
    write(data: string) {
      this.written += data
    }
    reset() {
      this.written = ''
    }
    onData() {
      return { dispose() {} }
    }
    onResize() {
      return { dispose() {} }
    }
    dispose() {}
  },
}))
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {}
    activate() {}
    dispose() {}
  },
}))
