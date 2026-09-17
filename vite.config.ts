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
        // changeOrigin only rewrites the outgoing Host header; the daemon's CSRF
        // guard (src/server/routes.ts: isForbiddenCrossOrigin) compares Origin
        // against Host and rejects every mutating request unless Origin matches
        // too, since the browser still stamps Origin as localhost:5173.
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            proxyReq.setHeader('origin', 'http://localhost:24680');
          });
        },
      }
    }
  },
  build: {
    outDir: '../web/dist',
    emptyOutDir: true
  }
})
