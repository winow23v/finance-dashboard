import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const target = process.env.FINANCE_DEV_API_TARGET ?? 'http://192.168.0.68:8088'
const privateToken = process.env.FINANCE_PRIVATE_API_TOKEN
const privateTarget = target === 'http://127.0.0.1:3001'

function browserPolicy(mode: string): Plugin {
  const env = loadEnv(mode, process.cwd(), 'VITE_')
  const origins = new Set<string>()
  for (const name of ['VITE_API_BASE_URL', 'VITE_SUPABASE_URL']) {
    const value = env[name]?.trim()
    if (!value) continue
    let url: URL
    try {
      url = new URL(value)
    } catch {
      throw new Error(`${name} must be an HTTPS URL`)
    }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
      throw new Error(`${name} must be an HTTPS URL without credentials, query or fragment`)
    }
    origins.add(url.origin)
  }

  return {
    name: 'finance-browser-policy',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        const policy = [
          "default-src 'self'",
          "script-src 'self'",
          "style-src 'self'",
          "style-src-attr 'unsafe-inline'",
          "img-src 'self'",
          "font-src 'self'",
          ["connect-src 'self'", ...origins].join(' '),
          "object-src 'none'",
          "base-uri 'self'",
          "form-action 'self'",
          "frame-src 'none'",
        ].join('; ')
        // Place the policy before Vite's generated asset tags, after the charset.
        return html.replace('<meta charset="UTF-8" />',
          `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />`)
      },
    },
  }
}

export default defineConfig(({ command, mode }) => ({
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
  plugins: [react(), tailwindcss(), command === 'build' && browserPolicy(mode)],
}))
