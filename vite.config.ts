import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const target = process.env.FINANCE_DEV_API_TARGET ?? 'http://192.168.0.68:8088'
const privateToken = process.env.FINANCE_PRIVATE_API_TOKEN
const privateTarget = target === 'http://127.0.0.1:3001'

export default defineConfig({
  base: process.env.PAGES_BASE_PATH ?? '/finance-dashboard/',
  server: {
    ...(privateTarget ? { host: '127.0.0.1', cors: false } : {}),
    proxy: {
      ...(privateTarget && privateToken ? {
        '^/api/v1/economy/indicators(?:\\?|$)': {
          target,
          changeOrigin: true,
          bypass(request) {
            if (request.socket.remoteAddress !== '127.0.0.1' ||
              request.headers.host !== `127.0.0.1:${request.socket.localPort}` ||
              request.headers['sec-fetch-site'] !== 'same-origin' ||
              (request.headers.origin && request.headers.origin !== `http://${request.headers.host}`)) {
              return false
            }
          },
          configure(proxy) {
            proxy.on('proxyReq', request => request.setHeader('Authorization', `Bearer ${privateToken}`))
          },
        },
      } : {}),
      '/api/': target,
    },
  },
  preview: { proxy: {} },
  plugins: [react(), tailwindcss()],
})
