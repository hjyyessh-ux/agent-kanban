import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: 'web',
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:24680',
        changeOrigin: true,
      }
    }
  },
  build: {
    outDir: '../web/dist',
    emptyOutDir: true
  }
})
