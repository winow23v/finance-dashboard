import type { DailyOhlcvBar, MarketDailyHistory } from '../types/marketDataProvider'

const windows = [20, 50, 100, 200] as const

function validBars(bars: readonly DailyOhlcvBar[]) {
  return bars.every(({ tradingDate, open, high, low, close, volume }, index) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(tradingDate) || (index && tradingDate <= bars[index - 1].tradingDate)) return false
    const utc = new Date(tradingDate)
    return Number.isFinite(+utc) && utc.toISOString().slice(0, 10) === tradingDate
      && [open, high, low, close, volume].every(Number.isFinite)
      && low > 0 && low <= Math.min(open, close) && high >= Math.max(open, close) && volume >= 0
  })
}

function average(values: readonly number[], period: number): number | null {
  return values.length < period ? null : values.slice(-period).reduce((sum, value) => sum + value, 0) / period
}

// All recursive averages start at the SMA of the first full window.
function smoothed(values: readonly number[], period: number, alpha: number): number[] {
  const seed = average(values.slice(0, period), period)
  if (seed === null) return []
  const result = [seed]
  for (const value of values.slice(period)) {
    const previous = result[result.length - 1]
    result.push(previous + alpha * (value - previous))
  }
  return result
}

const ema = (values: readonly number[], period: number) => smoothed(values, period, 2 / (period + 1))
const wilder = (values: readonly number[]) => smoothed(values, 14, 1 / 14).at(-1)
const latest = (values: number[]) => values.at(-1) ?? null

export function calculatePriceReturns(history: MarketDailyHistory) {
  const { bars } = history
  const last = bars.at(-1)
  const newestFirst = last && history.completeness === 'complete' && validBars(bars) ? [...bars].reverse() : []
  return Object.fromEntries([1, 3, 6].map(months => {
    if (!last || !newestFirst.length) return [months, null]
    const cutoff = new Date(last.tradingDate + 'T00:00:00Z')
    const date = cutoff.getUTCDate()
    cutoff.setUTCDate(1)
    cutoff.setUTCMonth(cutoff.getUTCMonth() - months)
    const end = Date.UTC(cutoff.getUTCFullYear(), cutoff.getUTCMonth() + 1, 0)
    cutoff.setUTCDate(Math.min(date, new Date(end).getUTCDate()))
    const boundary = cutoff.toISOString().slice(0, 10)
    const previous = newestFirst.find(bar => bar.tradingDate <= boundary)
    return [months, previous ? { percent: (last.close / previous.close - 1) * 100, tradingDate: previous.tradingDate } : null]
  }))
}

export function calculateTechnicalIndicators(history: MarketDailyHistory) {
  const { bars } = history
  if (history.completeness !== 'complete' || !bars.length || !validBars(bars)) return null
  const closes = bars.map(bar => bar.close)
  const changes = closes.slice(1).map((close, index) => close - closes[index])
  const gains = wilder(changes.map(delta => Math.max(delta, 0)))
  const losses = wilder(changes.map(delta => Math.max(-delta, 0)))
  const rsi14 = gains === undefined || losses === undefined ? null
    : losses === 0 ? (gains === 0 ? 50 : 100) : 100 - 100 / (1 + gains / losses)
  const ranges = bars.slice(1).map(({ high, low }, index) =>
    Math.max(high - low, Math.abs(high - closes[index]), Math.abs(low - closes[index])))
  const fast = ema(closes, 12)
  const macdSeries = ema(closes, 26).map((slow, index) => fast[index + 14] - slow)
  const line = latest(macdSeries)
  const signal = latest(ema(macdSeries, 9))
  return {
    tradingDate: bars[bars.length - 1].tradingDate,
    sma: Object.fromEntries(windows.map(period => [period, average(closes, period)])),
    ema: Object.fromEntries(windows.map(period => [period, latest(ema(closes, period))])),
    sma20Slope: closes.length < 21 ? null : (closes[closes.length - 1] - closes[closes.length - 21]) / 20,
    rsi14,
    macd: { line, signal, histogram: line === null || signal === null ? null : line - signal },
    volumeSma20: average(bars.map(bar => bar.volume), 20),
    atr14: wilder(ranges) ?? null,
  }
}
