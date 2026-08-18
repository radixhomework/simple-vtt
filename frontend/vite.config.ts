import { defineConfig } from 'vite'
import pkg from './package.json'

export default defineConfig({
  define: {
    // Replaced at build time with the frontend package version
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
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
