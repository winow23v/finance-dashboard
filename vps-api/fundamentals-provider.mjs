import { createHash } from 'node:crypto'
import { calculateFundamentals, fundamentalFormulaVersion } from './fundamental-ratios-provider.mjs'
import { createMarketCache } from './market-cache.mjs'
import { isDay, ProviderError } from './public-provider.mjs'

export function createFundamentalsProvider({ readFinancials, readMarket, clock = Date.now }) {
  const cache = createMarketCache({ maxEntries: 24, maxBytes: 512 * 1024, maxResponseBytes: 96 * 1024,
    maxPending: 4, timeoutMs: 5000, wallClock: clock })
  const pending = new Map()
  async function load(symbol, evaluationDate) {
    const [financials, market] = await Promise.all([
      readFinancials(symbol, evaluationDate), readMarket(symbol, evaluationDate),
    ])
    const input = { evaluationDate, financials, market }
    const digest = createHash('sha256').update(JSON.stringify(input)).digest('hex')
    const receipts = financials.years.map(report => [report.receipt?.id ?? '', report.scope ?? ''].join('/')).join(',')
    const key = [fundamentalFormulaVersion, symbol, financials.mapping?.issuer?.corpCode, evaluationDate, receipts, digest].join(':')
    const cached = await cache.get(key, { ttlMs: 5 * 60_000, staleAfterMs: 0 }, () => ({
      data: calculateFundamentals(input, clock), asOf: null,
    }))
    return JSON.parse(cached.body)
  }

  return (symbol, asOf) => {
    const today = new Date(clock() + 9 * 3_600_000).toISOString().slice(0, 10)
    const day = asOf ?? today
    if (!isDay(day) || day > today) throw new ProviderError(400, 'INVALID_FUNDAMENTAL_EVALUATION_DATE')
    const key = symbol + ':' + day
    if (pending.has(key)) return pending.get(key)
    if (pending.size >= 4) throw new ProviderError(503, 'FUNDAMENTAL_EVALUATION_BUSY')
    const calculation = load(symbol, day).finally(() => pending.delete(key))
    pending.set(key, calculation)
    return calculation
  }
}
