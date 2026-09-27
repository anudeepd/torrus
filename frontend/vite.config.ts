import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
  },
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    // `make dev` serves the backend on torrus's default port; every path the SPA
    // reaches over HTTP or the socket has to be forwarded to it.
    proxy: {
      '/socket.io': {
        target: 'http://127.0.0.1:8080',
        changeOrigin: true,
        ws: true,
      },
      '/api': { target: 'http://127.0.0.1:8080', changeOrigin: true },
      '/sftp': { target: 'http://127.0.0.1:8080', changeOrigin: true },
      '/_upload': { target: 'http://127.0.0.1:8080', changeOrigin: true },
      '/_auth': { target: 'http://127.0.0.1:8080', changeOrigin: true },
    },
  },
  build: {
    outDir: '../src/torrus/static',
    emptyOutDir: true,
    // Keep small assets inline, but never the woff2 faces: inlined they made the
    // render-blocking stylesheet 415 KB (90% base64) and uncacheable per face.
    assetsInlineLimit: 4096,
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-react': ['react', 'react-dom'],
          'vendor-xterm': ['@xterm/xterm', '@xterm/addon-fit', '@xterm/addon-web-links'],
          'vendor-socket': ['socket.io-client'],
          'vendor-ui': ['lucide-react', 'clsx', 'zustand'],
        },
      },
    },
  },
})
