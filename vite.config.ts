import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  base: process.env.PAGES_BASE_PATH ?? '/finance-dashboard/',
  server: {
    proxy: {
      '/api/': 'http://192.168.0.68:8088',
    },
  },
  preview: { proxy: {} },
  plugins: [react(), tailwindcss()],
})
