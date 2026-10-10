import { defineConfig } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  main: {
    build: {
      outDir: 'out/main',
      lib: {
        entry: resolve(__dirname, 'electron/main.js'),
        formats: ['cjs']
      },
      rollupOptions: {
        // 原生模块与含 .wasm 的包都不能被打包，必须留给运行时从 node_modules 加载
        external: [
          'ws',
          'better-sqlite3',
          'node-sqlite3-wasm',
          'electron-updater',
          '@ffmpeg-installer/ffmpeg',
          '@ffmpeg-installer/win32-x64'
        ]
      }
    }
  },
  preload: {
    build: {
      outDir: 'out/preload',
      lib: {
        entry: resolve(__dirname, 'electron/preload.js'),
        formats: ['cjs']
      },
      rollupOptions: {
        external: ['electron']
      }
    }
  },
  renderer: {
    plugins: [vue(), tailwindcss()],
    server: {
      port: 5173
    }
  }
})
