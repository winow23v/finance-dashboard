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
  binary = false, maxBytes = 16 * 1024 * 1024, queue = false, dailyLimit = 0, timeoutMs = 6000,
  forbiddenCooldownMs = 0, clock = Date.now,
} = {}) {
  let next = 0
  let active = 0
  let blockedUntil = -Infinity
  const recent = []
  const checkAccess = () => {
    if (clock() < blockedUntil) throw new ProviderError(503, 'SEC_ACCESS_RESTRICTED')
  }
  return async (url, headers = {}, requestTimeoutMs = timeoutMs) => {
    checkAccess()
    if (active >= 2 || (!queue && performance.now() < next)) throw new ProviderError(503, 'PROVIDER_BUSY')
    active++
    while (performance.now() < next) await delay(Math.ceil(next - performance.now()))
    const signal = AbortSignal.timeout(requestTimeoutMs)
    try {
      checkAccess()
      const now = performance.now()
      if (dailyLimit) {
        while (recent.length && recent[0] <= now - 86_400_000) recent.shift()
        if (recent.length >= dailyLimit) throw new ProviderError(503, 'PROVIDER_RATE_LIMITED')
        recent.push(now)
      }
      next = now + intervalMs
      const response = await fetchImpl(url, { headers: { Accept: binary ? 'application/zip, application/json' : 'application/json', ...headers }, signal, redirect: 'error' })
      if (response.status === 403 && forbiddenCooldownMs) {
        blockedUntil = clock() + forbiddenCooldownMs
        const error = new ProviderError(503, 'SEC_ACCESS_RESTRICTED')
        void response.body?.cancel().catch(() => {})
        throw error
      }
      if (response.status === 429) throw new ProviderError(503, 'PROVIDER_RATE_LIMITED')
      if (!response.ok) throw new ProviderError(502, 'PROVIDER_UNAVAILABLE')
      try {
        let size = 0
        const chunks = []
        if (!response.body) throw invalidResponse()
        for await (const chunk of response.body) {
          size += chunk.length
          if (size > maxBytes) throw invalidResponse()
          chunks.push(chunk)
        }
        const body = Buffer.concat(chunks, size)
        return binary ? body : JSON.parse(body.toString('utf8'))
      } catch {
        if (signal.aborted) throw new ProviderError(504, 'PROVIDER_TIMEOUT')
        throw invalidResponse()
      }
    } catch (error) {
      if (error instanceof ProviderError) throw error
      throw signal.aborted
        ? new ProviderError(504, 'PROVIDER_TIMEOUT')
        : new ProviderError(502, 'PROVIDER_UNAVAILABLE')
    } finally {
      active--
    }
  }
}
