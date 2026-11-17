/// <reference types="vitest/config" />
import { fileURLToPath, URL } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const layer = (name: string) => fileURLToPath(new URL(`./src/${name}`, import.meta.url))

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    // One alias per Feature-Sliced Design layer this app has (see tsconfig.app.json)
    alias: { '@/app': layer('app'), '@/pages': layer('pages'), '@/shared': layer('shared') },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
  },
})
