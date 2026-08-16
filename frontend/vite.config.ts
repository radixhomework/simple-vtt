import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8080',
      '/ws': { target: 'ws://localhost:8080', ws: true },
      '/uploads': 'http://localhost:8080',
    },
  },
  build: {
    outDir: '../backend/public',
    emptyOutDir: true,
  },
})
