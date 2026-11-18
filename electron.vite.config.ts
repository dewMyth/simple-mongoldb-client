import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Editors built on Electron (VS Code, Cursor) export ELECTRON_RUN_AS_NODE=1 to child shells, which makes
// the spawned app start as plain Node. This config runs in the process that spawns Electron, so clear it here.
delete process.env['ELECTRON_RUN_AS_NODE']

const alias = { '@shared': resolve(__dirname, 'src/shared') }

export default defineConfig({
  main: {
    resolve: { alias },
    build: { externalizeDeps: true }
  },
  preload: {
    resolve: { alias },
    build: {
      externalizeDeps: false,
      // Sandboxed preloads must be CommonJS and may only require('electron').
      rollupOptions: {
        external: ['electron'],
        output: { format: 'cjs', entryFileNames: '[name].cjs' }
      }
    }
  },
  renderer: {
    resolve: {
      alias: {
        ...alias,
        '@renderer': resolve(__dirname, 'src/renderer/src'),
        'whatwg-url': resolve(__dirname, 'src/renderer/src/lib/whatwg-url-shim.ts')
      }
    },
    plugins: [react(), tailwindcss()]
  }
})
