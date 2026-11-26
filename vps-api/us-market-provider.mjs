import { healthMetadata, withHealthMetadata } from './public-provider.mjs'
import { open, readdir, readFile, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { isDay } from './public-provider.mjs'

const tickerPattern = /^[A-Z][A-Z0-9]{0,9}(?:-[A-Z0-9]{1,5})?$/
export const usTickerSchema = { type: 'string', pattern: tickerPattern.source }
const source = 'Yahoo Finance via yfinance'
const reasons = ['not-published', 'provider-error', 'rate-limited', 'unsupported']
const validTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value))

function validBars(bars) {
  return Array.isArray(bars) && bars.length > 0 && bars.length <= 550 && bars.every((bar, index) => {
    const { tradingDate, open, high, low, close, volume } = bar ?? {}
    return isDay(tradingDate) && (!index || tradingDate > bars[index - 1].tradingDate) &&
      [open, high, low, close].every(value => Number.isFinite(value) && value > 0) &&
      high >= Math.max(open, close) && low <= Math.min(open, close) &&
      Number.isSafeInteger(volume) && volume >= 0
  })
}

export function configureMemberUsMarket({
  enabled = process.env.FINANCE_MEMBER_US_MARKET,
  root = process.env.US_MARKET_CACHE_DIR,
  queue = process.env.US_MARKET_QUEUE_DIR,
} = {}) {
  if (enabled !== '1') return
  if (!root || !isAbsolute(root) || (queue && !isAbsolute(queue))) return
  return createUsMarketProvider({ root, queue })
}

export function createUsMarketProvider({ root, queue, clock = Date.now }) {
  const pending = new Map()
  let queueWrite = Promise.resolve()
  function enqueue(symbol) {
    const request = queueWrite.then(async () => {
      const entries = await readdir(queue)
      if (entries.includes(symbol)) return 'collecting'
      if (entries.length >= 32) return 'rate-limited'
      await (await open(join(queue, symbol), 'wx', 0o640)).close()
      return 'collecting'
    }).catch(error => error.code === 'EEXIST' ? 'collecting' : 'provider-error')
    queueWrite = request
    return request
  }

  async function load(symbol, index) {
    let record
    try {
      record = JSON.parse(await readFile(join(root, index ? 'indices' : 'stocks', symbol + '.json'), 'utf8'))
    } catch (error) {
      if (error.code === 'ENOENT') return { status: 'unavailable', reason: 'not-published' }
      return { status: 'unavailable', reason: 'provider-error' }
    }
    if (record?.version !== 1 || record.symbol !== symbol) return { status: 'unavailable', reason: 'provider-error' }
    const { snapshot, attempt } = record
    const reason = reasons.includes(attempt?.reason) ? attempt.reason : null
    const telemetry = { usedCache: Boolean(snapshot), attemptedAt: attempt?.attemptedAt,
      retries: Number.isSafeInteger(attempt?.count) && attempt.count > 0 ? attempt.count - 1 : 0 }
    if (!snapshot) return withHealthMetadata({ status: 'unavailable', reason: reason ?? 'not-published' }, telemetry)
    const { raw, adjusted, tradingDate, observedAt, collectedAt, nextSessionClose } = snapshot
    if (!validBars(raw) || raw.at(-1).tradingDate !== tradingDate ||
      ![observedAt, collectedAt, nextSessionClose].every(validTime) ||
      Date.parse(collectedAt) < Date.parse(observedAt) || Date.parse(nextSessionClose) <= Date.parse(observedAt) ||
      (!index && (!validBars(adjusted) || adjusted.length !== raw.length ||
        adjusted.some((row, i) => row.tradingDate !== raw[i].tradingDate || row.volume !== raw[i].volume)))) {
      return { status: 'unavailable', reason: 'provider-error' }
    }
    const last = raw.at(-1)
    const previous = raw.at(-2)
    const change = previous ? last.close - previous.close : null
    const stale = Boolean(reason) || clock() >= Date.parse(nextSessionClose) + 20 * 60_000
    return withHealthMetadata({
      status: stale ? 'stale' : 'available', reason: reason ?? (stale ? 'not-published' : null),
      tradingDate, observedAt, collectedAt, source,
      quote: { ...last, change, changePercent: previous ? change / previous.close * 100 : null },
      raw, adjusted,
    }, telemetry)
  }

  function read(symbol, index = false) {
    if (!pending.has(symbol)) pending.set(symbol, load(symbol, index).finally(() => pending.delete(symbol)))
    return pending.get(symbol)
  }

  async function analysis(symbol, index = false) {
    const result = await read(symbol, index)
    const { raw, adjusted, ...data } = result
    if (!raw) return withHealthMetadata(data, result[healthMetadata])
    const bars = index ? raw : adjusted
    return withHealthMetadata({ ...data, analysisStatus: bars.length >= 260 ? 'available' : 'insufficient-history',
      history: { currency: 'USD', timeZone: 'America/New_York',
        adjustment: index ? 'unadjusted' : 'total-return-adjusted', completeness: 'complete', bars } }, result[healthMetadata])
  }

  async function stock(symbol) {
    if (!tickerPattern.test(symbol)) return { status: 'unavailable', reason: 'unsupported' }
    return analysis(symbol)
  }

  return {
    async index(symbol) {
      const result = await read(symbol, true)
      const { raw, adjusted, quote, ...state } = result
      return withHealthMetadata(quote ? { ...state, price: quote.close, change: quote.change, changePercent: quote.changePercent } : state,
        result[healthMetadata])
    },
    async history(symbol, period) {
      const result = await read(symbol, true)
      const { raw, observedAt, status, reason, tradingDate, collectedAt } = result
      const sessions = { '1D': 1, '1W': 5, '1M': 22, '3M': 66, '1Y': 252 }
      return withHealthMetadata({ asOf: observedAt ?? null, status, reason, tradingDate, collectedAt, data: raw?.slice(-sessions[period])
        .map(bar => ({ at: bar.tradingDate, value: bar.close })) ?? [] }, result[healthMetadata])
    },
    async stock(symbol) {
      const data = await stock(symbol)
      if (queue && tickerPattern.test(symbol) && data.status === 'unavailable' && data.reason === 'not-published') {
        const queued = await stat(join(queue, symbol)).catch(() => null)
        if (queued?.isFile()) return withHealthMetadata({ ...data, reason: 'collecting' }, data[healthMetadata])
      }
      return data
    },
    indexAnalysis: symbol => analysis(symbol, true),
    async request(symbol) {
      const data = await stock(symbol)
      if (!queue || !tickerPattern.test(symbol) ||
        (data.status !== 'stale' && !(data.status === 'unavailable' && data.reason === 'not-published'))) return data
      const reason = await enqueue(symbol)
      return withHealthMetadata({ ...data, reason }, data[healthMetadata])
    },
  }
}
