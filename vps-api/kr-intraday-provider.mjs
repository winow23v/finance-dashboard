import { isDay, ProviderError } from './public-provider.mjs'

const markets = new Set(['KOSPI', 'KOSDAQ'])
const venues = new Set(['KRX', 'NXT'])
const sessions = new Set(['pre-market', 'regular', 'after-hours'])
const koreanDate = time => new Date(time + 9 * 3_600_000).toISOString().slice(0, 10)
const positivePrice = value => Number.isFinite(value) && value > 0 && value <= Number.MAX_SAFE_INTEGER
const nonnegative = value => Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER

function normalize(row, instrument, tradingDate, now, source) {
  if (!row || row.symbol !== instrument.symbol || row.market !== instrument.market || row.tradingDate !== tradingDate ||
      (row.venue !== null && !venues.has(row.venue)) || !sessions.has(row.session) ||
      ![row.price, row.previousClose, row.open, row.high, row.low].every(positivePrice) ||
      row.low > Math.min(row.open, row.price) || row.high < Math.max(row.open, row.price) ||
      !Number.isSafeInteger(row.volume) || row.volume < 0 ||
      (row.turnover !== null && !nonnegative(row.turnover)) ||
      (row.delayMinutes !== null && (!Number.isSafeInteger(row.delayMinutes) || row.delayMinutes < 0)) ||
      typeof row.observedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|\+09:00)$/.test(row.observedAt)) return null
  if (!isDay(row.observedAt.slice(0, 10)) || koreanDate(now) !== tradingDate) return null
  const observedAt = Date.parse(row.observedAt)
  if (!Number.isFinite(observedAt) || observedAt > now || koreanDate(observedAt) !== tradingDate) return null
  const change = row.price - row.previousClose
  const changePercent = change / row.previousClose * 100
  if (!Number.isFinite(changePercent)) return null
  return {
    symbol: row.symbol, name: instrument.name?.trim() || row.symbol, market: row.market, venue: row.venue,
    price: row.price, previousClose: row.previousClose, change, changePercent,
    open: row.open, high: row.high, low: row.low, volume: row.volume, turnover: row.turnover,
    observedAt: new Date(observedAt).toISOString(), tradingDate, session: row.session, source,
    delayMinutes: row.delayMinutes, status: 'available', basis: 'intraday',
  }
}

// A vetted adapter supplies a calendar check and a normalized wire reader. No
// provider is configured in production until member-display rights are verified.
export function createKrxIntradayProvider({ read, approvalFor, tradingSession, clock = Date.now,
  maxRequestsPerMinute = 12, timeoutMs = 3_000 } = {}) {
  const cache = new Map()
  const pending = new Map()
  let requests = []
  let blockedUntil = 0
  const unavailable = reason => ({ status: 'unavailable', reason, basis: 'intraday' })

  return {
    async quote(instrument) {
      const { market, symbol } = instrument
      if (!markets.has(market) || typeof symbol !== 'string' || !/^[A-Z0-9]{6}$/.test(symbol)) return unavailable('unsupported')
      const approval = approvalFor?.(instrument)
      if (!read || approval?.memberDisplay !== true || typeof approval.source !== 'string' || !approval.source.trim())
        return unavailable('not-configured')
      const now = clock()
      const session = tradingSession?.(now, instrument)
      if (!session?.open || session.tradingDate !== koreanDate(now)) return unavailable('market-closed')
      const { tradingDate } = session
      const key = JSON.stringify([approval.source, market, symbol, tradingDate])
      const previous = cache.get(key)
      if (approval.cacheTtlMs > 0 && previous?.expiresAt > now) return previous.quote
      if (pending.has(key)) return pending.get(key)
      requests = requests.filter(at => now - at < 60_000)
      if (now < blockedUntil || requests.length >= maxRequestsPerMinute || pending.size) return unavailable('rate-limited')
      requests.push(now)
      const request = Promise.resolve().then(async () => {
        try {
          const row = await read(instrument, { tradingDate, signal: AbortSignal.timeout(timeoutMs) })
          const quote = normalize(row, instrument, tradingDate, clock(), approval.source)
          if (!quote) return unavailable('invalid-observation')
          if (Number.isFinite(approval.cacheTtlMs) && approval.cacheTtlMs > 0) {
            cache.delete(key)
            cache.set(key, { quote, expiresAt: clock() + approval.cacheTtlMs })
            if (cache.size > 64) cache.delete(cache.keys().next().value)
          }
          return quote
        } catch (error) {
          if (!(error instanceof ProviderError) || error.code !== 'PROVIDER_RATE_LIMITED') return unavailable('provider-error')
          const wait = error.retryAfterMs
          blockedUntil = clock() + (Number.isFinite(wait) && wait >= 0 ? wait : 60_000)
          return unavailable('rate-limited')
        }
      }).finally(() => pending.delete(key))
      pending.set(key, request)
      return request
    },
  }
}
