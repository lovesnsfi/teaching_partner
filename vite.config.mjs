import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

// Tauri 版前端构建：入口用 src/renderer/index.html，产物输出到 dist/（src-tauri 的 frontendDist 指向这里）。
// 注意：本文件是 Tauri 专用；Electron 版仍用 electron.vite.config.mjs，两者互不影响。
// 用 .mjs 扩展名，确保按 ESM 加载（@tailwindcss/vite 是 ESM-only，.js 会被当 CJS 而失败）。
export default defineConfig({
  plugins: [vue(), tailwindcss()],
  root: 'src/renderer',
  build: {
    outDir: '../../dist',
    emptyOutDir: true
  },
  server: {
    port: 1420,
    strictPort: true
  },
  clearScreen: false
})
