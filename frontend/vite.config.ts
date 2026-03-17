import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    // During local development, proxy /api to the Go backend
    proxy: {
      '/api/ws': {
        target: 'ws://localhost:8080',
        ws: true,
      },
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
    },
  },
})
