import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/preload/index.ts'),
          'terminal-preload': resolve('src/preload/terminal-preload.ts'),
          'overlay-preload': resolve('src/preload/overlay-preload.ts'),
          'ask-user-preload': resolve('src/preload/ask-user-preload.ts')
        },
        output: {
          entryFileNames: '[name].js'
        }
      }
    }
  },
  renderer: {
    server: {
      port: 5199,
      strictPort: false
    },
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer')
      }
    },
    plugins: [react()],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          terminal: resolve('src/renderer/terminal.html'),
          overlay: resolve('src/renderer/overlay.html'),
          'ask-user': resolve('src/renderer/ask-user.html')
        }
      }
    }
  }
})
