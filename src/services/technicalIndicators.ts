import type { DailyOhlcvBar, MarketDailyHistory } from '../types/marketDataProvider'

export const smaWindows = [5, 20, 50, 60, 100, 120, 200, 365] as const
export const emaWindows = [20, 50, 100, 200] as const
const wilderPeriod = 14
const finite = (value: number) => Number.isFinite(value) ? value : null

function validBars(bars: readonly DailyOhlcvBar[]) {
  return bars.every(({ tradingDate, open, high, low, close, volume }, index) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(tradingDate) || (index && tradingDate <= bars[index - 1].tradingDate)) return false
    const utc = new Date(tradingDate)
    return Number.isFinite(+utc) && utc.toISOString().slice(0, 10) === tradingDate
      && [open, high, low, close, volume].every(value => Number.isFinite(value) && value <= Number.MAX_SAFE_INTEGER)
      && low > 0 && low <= Math.min(open, close) && high >= Math.max(open, close) && volume >= 0
  })
}

function average(values: readonly number[], period: number): number | null {
  return values.length < period ? null : values.slice(-period).reduce((sum, value) => sum + value, 0) / period
}

export { average as simpleMovingAverage }

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
const wilder = (values: readonly number[]) => smoothed(values, wilderPeriod, 1 / wilderPeriod).at(-1)
const latest = (values: number[]) => values.at(-1) ?? null

function directionalMovement(bars: readonly DailyOhlcvBar[], ranges: readonly number[]) {
  const period = wilderPeriod
  if (ranges.length < period) return { adx: null, plus: null, minus: null }
  const plusMoves: number[] = []
  const minusMoves: number[] = []
  for (let i = 1; i < bars.length; i++) {
    const up = bars[i].high - bars[i - 1].high
    const down = bars[i - 1].low - bars[i].low
    plusMoves.push(up > down && up > 0 ? up : 0)
    minusMoves.push(down > up && down > 0 ? down : 0)
  }
  // DMI uses the first 13 transitions as a sum, then applies Wilder's update
  // from transition 14, following TA-Lib's DMI/ADX initialization.
  const seed = (values: readonly number[]) => values.slice(0, period - 1).reduce((sum, value) => sum + value, 0)
  let tr = seed(ranges)
  let plusSum = seed(plusMoves)
  let minusSum = seed(minusMoves)
  let plus = 0
  let minus = 0
  const dx: number[] = []
  for (let i = period - 1; i < ranges.length; i++) {
    tr += ranges[i] - tr / period
    plusSum += plusMoves[i] - plusSum / period
    minusSum += minusMoves[i] - minusSum / period
    plus = tr > 0 ? 100 * (plusSum / tr) : 0
    minus = tr > 0 ? 100 * (minusSum / tr) : 0
    dx.push(plus + minus > 0 ? 100 * Math.abs(plus - minus) / (plus + minus) : 0)
  }
  return { adx: wilder(dx) ?? null, plus, minus }
}

function movingAverageCross(bars: readonly DailyOhlcvBar[]) {
  let fast = 0
  let slow = 0
  let previous = 0
  let event: { type: 'golden' | 'dead'; tradingDate: string } | null = null
  for (const [index, { close, tradingDate }] of bars.entries()) {
    fast += close - (bars[index - 50]?.close ?? 0)
    slow += close - (bars[index - 200]?.close ?? 0)
    if (index < 199) continue
    const diff = fast / 50 - slow / 200
    const tolerance = 1e-12 * Math.max(Math.abs(fast / 50), Math.abs(slow / 200))
    if (Math.abs(diff) <= tolerance) continue
    const direction = Math.sign(diff)
    if (previous && previous !== direction) event = { type: direction > 0 ? 'golden' : 'dead', tradingDate }
    previous = direction
  }
  return { lastEvent: event }
}

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
    const percent = previous ? finite((last.close / previous.close - 1) * 100) : null
    return [months, previous && percent !== null ? { percent, tradingDate: previous.tradingDate } : null]
  }))
}

export function calculateTechnicalIndicators(history: MarketDailyHistory, options: { volumeSpikeThreshold?: number } = {}) {
  const { bars } = history
  if (history.completeness !== 'complete' || !bars.length || !validBars(bars)) return null
  const closes = bars.map(bar => bar.close)
  const changes = closes.slice(1).map((close, index) => close - closes[index])
  const rsi14 = rsiSeries(changes).at(-1) ?? null
  const ranges = bars.slice(1).map(({ high, low }, index) =>
    Math.max(high - low, Math.abs(high - closes[index]), Math.abs(low - closes[index])))
  const { line: macdSeries, signal: macdSignal } = macdSeriesFor(closes)
  const line = latest(macdSeries)
  const signal = latest(macdSignal)
  const previousHistogram = macdSeries.length > 1 && macdSignal.length > 1
    ? macdSeries.at(-2)! - macdSignal.at(-2)! : null
  const histogram = line === null || signal === null ? null : line - signal
  const macdCross = histogram === null || previousHistogram === null ? null
    : histogram > 0 && previousHistogram <= 0 ? 'up'
      : histogram < 0 && previousHistogram >= 0 ? 'down' : null
  const last = bars[bars.length - 1]
  const sma = Object.fromEntries(smaWindows.map(period => [period, average(closes, period)]))
  const priorCloses = closes.slice(0, -1)
  const previousSma = Object.fromEntries([20, 50, 200].map(period => [period, average(priorCloses, period)]))
  const previousSma20 = previousSma[20]
  const middle = sma[20]
  // Bollinger Bands use population variance over the 20 observed closes.
  const bands = middle === null ? null : (() => {
    const deviation = Math.sqrt(closes.slice(-20).reduce((sum, close) => sum + (close - middle) ** 2, 0) / 20)
    const upper = middle + 2 * deviation
    const lower = middle - 2 * deviation
    const width = upper - lower
    return { middle, lower, upper,
      percentB: width > 0 ? finite((last.close - lower) / width * 100) : null,
      bandwidth: finite(width / middle * 100) }
  })()
  const volumes = bars.map(bar => bar.volume)
  const volumeSma20 = average(volumes, 20)
  const prior20 = average(volumes.slice(0, -1), 20)
  const volumeRatio = prior20 !== null && prior20 > 0 ? finite(last.volume / prior20) : null
  const supplied = options.volumeSpikeThreshold ?? 1.5
  const spikeThreshold = Number.isFinite(supplied) && supplied > 1 ? supplied : 1.5
  return {
    tradingDate: last.tradingDate,
    close: last.close,
    sma,
    ema: Object.fromEntries(emaWindows.map(period => [period, latest(ema(closes, period))])),
    sma20Slope: middle === null || previousSma20 === null ? null : middle - previousSma20,
    rsi14,
    macd: { line, signal, histogram },
    macdCross,
    volumeSma20,
    volumeSma50: average(volumes, 50),
    volume: { latest: last.volume, sma5: average(volumes, 5), prior20, ratio: volumeRatio,
      spikeThreshold, spike: volumeRatio === null ? null : volumeRatio >= spikeThreshold },
    atr14: wilder(ranges) ?? null,
    prior: { sma: previousSma, atr14: wilder(ranges.slice(0, -1)) ?? null },
    dmi: directionalMovement(bars, ranges),
    bands,
    cross: movingAverageCross(bars),
  }
}

function rsiSeries(changes: readonly number[]) {
  const gain = smoothed(changes.map(delta => Math.max(delta, 0)), wilderPeriod, 1 / wilderPeriod)
  const loss = smoothed(changes.map(delta => Math.max(-delta, 0)), wilderPeriod, 1 / wilderPeriod)
  return gain.map((up, index) => loss[index] === 0 ? (up === 0 ? 50 : 100) : 100 - 100 / (1 + up / loss[index]))
}

function macdSeriesFor(closes: readonly number[]) {
  const fast = ema(closes, 12)
  const line = ema(closes, 26).map((slow, index) => fast[index + 14] - slow)
  return { line, signal: ema(line, 9) }
}

export function technicalChartSeries(history: MarketDailyHistory) {
  const { bars } = history
  if (!validBars(bars)) return []
  const valid = history.completeness === 'complete'
  const closes = bars.map(bar => bar.close)
  const volumes = bars.map(bar => bar.volume)
  const averages = emaWindows.map(period => ema(closes, period))
  const rsi = rsiSeries(closes.slice(1).map((close, index) => close - closes[index]))
  const macd = macdSeriesFor(closes)
  return bars.map((bar, index) => {
    const sma = (values: number[], period: number) =>
      valid ? average(values.slice(Math.max(0, index + 1 - period), index + 1), period) : null
    const line = valid ? macd.line[index - 25] ?? null : null
    const signal = valid ? macd.signal[index - 33] ?? null : null
    return {
      ...bar, candleRange: [bar.low, bar.high], sma20: sma(closes, 20), sma50: sma(closes, 50), sma365: sma(closes, 365),
      ema20: valid ? averages[0][index - 19] ?? null : null,
      ema50: valid ? averages[1][index - 49] ?? null : null,
      ema100: valid ? averages[2][index - 99] ?? null : null,
      ema200: valid ? averages[3][index - 199] ?? null : null,
      volume20: sma(volumes, 20), volume50: sma(volumes, 50),
      rsi: valid ? rsi[index - 14] ?? null : null,
      macd: line, signal, histogram: line === null || signal === null ? null : line - signal,
    }
  })
}

export type TechnicalIndicators = NonNullable<ReturnType<typeof calculateTechnicalIndicators>>
