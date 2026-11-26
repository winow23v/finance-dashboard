import { pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'
import { providerClient } from '../../vps-api/public-provider.mjs'

export async function probeApiHealth(endpoint, { fetchImpl = fetch, timeoutMs = 4_000 } = {}) {
  let url
  try { url = new URL(endpoint) } catch { throw new Error('Expected an HTTPS /health endpoint') }
  if (url.protocol !== 'https:' || url.pathname !== '/health' || url.username || url.password || url.search || url.hash)
    throw new Error('Expected an HTTPS /health endpoint')
  const get = providerClient(fetchImpl, 0, { detailedErrors: true, maxBytes: 4_096, timeoutMs })
  const started = performance.now()
  let httpStatus = null
  let errorCode = null
  try {
    const response = await get(url, {}, timeoutMs, status => { httpStatus = status })
    if (response?.status !== 'ok') errorCode = 'HEALTH_INVALID_RESPONSE'
  } catch (error) {
    errorCode = error.code === 'PROVIDER_TIMEOUT' ? 'HEALTH_TIMEOUT'
      : httpStatus !== null && httpStatus >= 400 ? 'HEALTH_HTTP_ERROR' : 'HEALTH_RESPONSE_ERROR'
  }
  return {
    status: errorCode ? 'Unavailable' : 'Healthy', httpStatus, errorCode,
    attemptedAt: new Date().toISOString(), responseMs: Math.round(performance.now() - started), mode: 'test',
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await probeApiHealth(process.argv[2])
    console.log(JSON.stringify(result))
    if (result.status !== 'Healthy') process.exitCode = 1
  } catch {
    console.error('Usage: node ops/health/probe.mjs https://example.org/health')
    process.exitCode = 2
  }
}
