import { performance } from 'node:perf_hooks'
import { ProviderError } from './public-provider.mjs'

export class MarketError extends Error {
  constructor(statusCode, message) {
    super(message)
    this.statusCode = statusCode
  }
}

export function createMarketCache({
  maxEntries = 128,
  maxBytes = 2 * 1024 * 1024,
  maxResponseBytes = 256 * 1024,
  maxPending = 16,
  timeoutMs = 5000,
  clock = performance.now.bind(performance),
  wallClock = Date.now,
} = {}) {
  const entries = new Map()
  const pending = new Map()
  let bytes = 0

  function remove(key) {
    bytes -= entries.get(key).body.length
    entries.delete(key)
  }

  async function refresh(key, ttlMs, load) {
    const controller = new AbortController()
    let timer
    try {
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new MarketError(503, 'Market provider timed out'))
          controller.abort()
        }, timeoutMs)
      })
      const { data, asOf } = await Promise.race([
        timeout,
        Promise.resolve().then(() => load(controller.signal)).catch(error => {
          if (error instanceof ProviderError) throw error
          throw new MarketError(502, 'Market provider failed')
        }),
      ])
      const marketTime = typeof asOf === 'string' ? Date.parse(asOf) : NaN
      const json = JSON.stringify(data)
      if (!Number.isFinite(marketTime) || !json || Buffer.byteLength(json) > maxResponseBytes) {
        throw new MarketError(502, 'Invalid market provider response')
      }

      const body = Buffer.from(json)
      const entry = { body, marketTime, storedAt: wallClock(), expiresAt: clock() + ttlMs }
      if (maxEntries > 0 && body.length <= maxBytes) {
        while (entries.size >= maxEntries || bytes + body.length > maxBytes) {
          remove(entries.keys().next().value)
        }
        entries.set(key, entry)
        bytes += body.length
      }
      return entry
    } catch (error) {
      if (error instanceof MarketError || error instanceof ProviderError) throw error
      throw new MarketError(502, 'Market provider failed')
    } finally {
      clearTimeout(timer)
      pending.delete(key)
    }
  }

  return {
    async get(key, { ttlMs, staleAfterMs }, load) {
      let entry = entries.get(key)
      if (entry) {
        remove(key)
        if (clock() >= entry.expiresAt) {
          entry = undefined
        } else {
          entries.set(key, entry)
          bytes += entry.body.length
        }
      }
      if (!entry) {
        let request = pending.get(key)
        if (!request) {
          if (pending.size >= maxPending) throw new MarketError(503, 'Market provider busy')
          request = refresh(key, ttlMs, load)
          pending.set(key, request)
        }
        entry = await request
      }
      return {
        body: entry.body,
        storedAt: new Date(entry.storedAt).toISOString(),
        asOf: new Date(entry.marketTime).toISOString(),
        stale: wallClock() - entry.marketTime >= staleAfterMs,
      }
    },
  }
}
