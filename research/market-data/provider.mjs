// Local research adapter. The production Fastify entry point does not import it.
import { readFile, realpath } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const symbols = ['AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'DELL', 'KO', 'JNJ', 'PG', '^GSPC', '^IXIC', '^DJI']
const periods = { '1W': 0, '1M': 1, '3M': 3, '6M': 6, '1Y': 12, '2Y': 24 }

function periodStart(tradingDate, period) {
  const start = new Date(tradingDate + 'T00:00:00Z')
  if (period === '1W') start.setUTCDate(start.getUTCDate() - 6)
  else {
    const day = start.getUTCDate()
    start.setUTCDate(1)
    start.setUTCMonth(start.getUTCMonth() - periods[period])
    const lastDay = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)).getUTCDate()
    start.setUTCDate(Math.min(day, lastDay))
  }
  return start.toISOString().slice(0, 10)
}
const unavailable = dataStatus => ({ dataStatus, distribution: 'local-research-only' })

export function createResearchProvider(root = fileURLToPath(new URL('.', import.meta.url))) {
  async function load(symbol) {
    if (!symbols.includes(symbol)) return unavailable('unsupported-symbol')
    try {
      const directory = await realpath(join(root, 'snapshots', symbol))
      const summary = JSON.parse(await readFile(join(directory, 'summary.json'), 'utf8'))
      if (summary.symbol !== symbol || summary.distribution !== 'local-research-only' || summary.dataStatus !== 'available') {
        return unavailable('invalid-snapshot')
      }
      return { directory, summary }
    } catch (error) {
      return unavailable(error.code === 'ENOENT' ? 'no-observation' : 'invalid-snapshot')
    }
  }

  function fields(summary) {
    const { source, symbol, currency, exchange, observedAt, tradingDate, collectedAt, isDelayed, timing,
      distribution } = summary
    const dataStatus = Date.now() >= Date.parse(summary.nextSessionClose) ? 'stale' : 'available'
    return { source, symbol, currency, exchange, observedAt, tradingDate, collectedAt, isDelayed, timing, dataStatus, distribution }
  }

  async function getQuote(symbol) {
    const entry = await load(symbol)
    if (!entry.summary) return entry
    const { summary } = entry
    const { adjustmentType, close, previousClose, volume } = summary.raw
    return { ...fields(summary), adjustmentType, close, previousClose, volume, quoteType: 'session-close' }
  }

  return {
    getQuote,
    async getHistory(symbol, period, adjustmentType = 'yahoo-raw') {
      if (!Object.hasOwn(periods, period)) return unavailable('unsupported-period')
      const files = { 'yahoo-raw': 'raw.csv', 'yahoo-auto-adjusted': 'adjusted.csv' }
      if (!Object.hasOwn(files, adjustmentType)) {
        return unavailable('unsupported-adjustment')
      }
      const entry = await load(symbol)
      if (!entry.summary) return entry
      try {
        const [header, ...lines] = (await readFile(join(entry.directory, files[adjustmentType]), 'utf8')).trim().split(/\r?\n/)
        if (header !== 'Date,Open,High,Low,Close,Volume' || lines.length !== entry.summary.rows) {
          return unavailable('invalid-snapshot')
        }
        const start = periodStart(entry.summary.tradingDate, period)
        const bars = lines.map(line => {
          const [tradingDate, ...values] = line.split(',')
          const [open, high, low, close, volume] = values.map(Number)
          if (!/^\d{4}-\d{2}-\d{2}$/.test(tradingDate) || values.length !== 5 ||
              !values.every(value => value !== '' && Number.isFinite(Number(value)))) throw new Error('Invalid OHLCV')
          return { tradingDate, open, high, low, close, volume }
        })
        return { ...fields(entry.summary), adjustmentType, bars: bars.filter(bar => bar.tradingDate >= start) }
      } catch {
        return unavailable('invalid-snapshot')
      }
    },
    async getIndicators(symbol) {
      const entry = await load(symbol)
      if (!entry.summary) return entry
      const { summary } = entry
      return {
        ...fields(summary),
        raw: { adjustmentType: summary.raw.adjustmentType, values: summary.raw.indicators },
        adjusted: { adjustmentType: summary.adjusted.adjustmentType, values: summary.adjusted.indicators },
      }
    },
    async getMarketOverview() {
      return { distribution: 'local-research-only', quotes: await Promise.all(symbols.map(getQuote)) }
    },
    async getMarketHeatmap() {
      return unavailable('no-verified-market-cap-or-sector')
    },
  }
}
