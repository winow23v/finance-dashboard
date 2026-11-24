import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'

export class ProviderError extends Error {
  constructor(statusCode, code) {
    super(code)
    this.statusCode = statusCode
    this.code = code
  }
}

export const invalidResponse = () => new ProviderError(502, 'INVALID_PROVIDER_RESPONSE')

export function isDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(value)
  return Number.isFinite(+date) && date.toISOString().slice(0, 10) === value
}

export function providerClient(fetchImpl, intervalMs, {
  binary = false, maxBytes = 16 * 1024 * 1024, queue = false, dailyLimit = 0, timeoutMs = 6000, detailedErrors = false,
} = {}) {
  let next = 0
  let active = 0
  const recent = []
  const bodyError = code => detailedErrors ? new ProviderError(502, code) : invalidResponse()
  return async (url, headers = {}, requestTimeoutMs = timeoutMs, observeResponse) => {
    if (active >= 2 || (!queue && performance.now() < next)) throw new ProviderError(503, 'PROVIDER_BUSY')
    active++
    while (performance.now() < next) await delay(Math.ceil(next - performance.now()))
    const signal = AbortSignal.timeout(requestTimeoutMs)
    try {
      const now = performance.now()
      if (dailyLimit) {
        while (recent.length && recent[0] <= now - 86_400_000) recent.shift()
        if (recent.length >= dailyLimit) throw new ProviderError(503, 'PROVIDER_RATE_LIMITED')
        recent.push(now)
      }
      next = now + intervalMs
      const response = await fetchImpl(url, { headers: { Accept: binary ? 'application/zip, application/json' : 'application/json', ...headers }, signal, redirect: 'error' })
      observeResponse?.(response.status)
      if (!response.ok) {
        void response.body?.cancel().catch(() => {})
        if (response.status === 429) throw new ProviderError(503, 'PROVIDER_RATE_LIMITED')
        throw new ProviderError(502, 'PROVIDER_UNAVAILABLE')
      }
      try {
        let size = 0
        const chunks = []
        if (!response.body) throw bodyError('PROVIDER_BODY_ERROR')
        for await (const chunk of response.body) {
          size += chunk.length
          if (size > maxBytes) throw bodyError('PROVIDER_RESPONSE_TOO_LARGE')
          chunks.push(chunk)
        }
        const body = Buffer.concat(chunks, size)
        if (binary) return body
        try {
          return JSON.parse(body.toString('utf8'))
        } catch {
          throw bodyError('PROVIDER_INVALID_JSON')
        }
      } catch (error) {
        if (signal.aborted) throw new ProviderError(504, 'PROVIDER_TIMEOUT')
        if (error instanceof ProviderError) throw error
        throw bodyError('PROVIDER_BODY_ERROR')
      }
    } catch (error) {
      if (error instanceof ProviderError) throw error
      throw signal.aborted
        ? new ProviderError(504, 'PROVIDER_TIMEOUT')
        : new ProviderError(502, detailedErrors ? 'PROVIDER_CONNECTION_ERROR' : 'PROVIDER_UNAVAILABLE')
    } finally {
      active--
    }
  }
}
