import assert from 'node:assert/strict'
import { test } from 'node:test'
import { calculatePriceReturns, calculateTechnicalIndicators } from './technicalIndicators.ts'

function history(closes) {
  return {
    currency: 'USD',
    timeZone: 'America/New_York',
    completeness: 'complete',
    adjustment: 'split-adjusted',
    bars: closes.map((close, index) => ({
      tradingDate: new Date(Date.UTC(2024, 0, index + 1)).toISOString().slice(0, 10),
      open: close, high: close + 1, low: close - 1, close, volume: 100 + index,
    })),
  }
}
const ramp = n => Array.from({ length: n }, (_, index) => 100 + index)

test('SMA, seeded EMA, volume SMA, MACD and Wilder measures on a linear series', () => {
  const result = calculateTechnicalIndicators(history(ramp(220)))
  assert.deepEqual(result.sma, { 20: 309.5, 50: 294.5, 100: 269.5, 200: 219.5 })
  for (const period of [20, 50, 100, 200]) assert.ok(Math.abs(result.ema[period] - result.sma[period]) < 1e-10)
  assert.deepEqual(result.macd, { line: 7, signal: 7, histogram: 0 })
  assert.equal(result.volumeSma20, 309.5)
  assert.equal(result.sma20Slope, 1)
  assert.equal(result.rsi14, 100)
  assert.equal(result.atr14, 2)
})

test('warmup windows hold unavailable values back', () => {
  const short = calculateTechnicalIndicators(history(ramp(14)))
  assert.equal(short.rsi14, null)
  assert.equal(short.atr14, null)
  assert.equal(short.ema[20], null)
  assert.equal(short.volumeSma20, null)
  assert.equal(short.sma20Slope, null)
  assert.deepEqual(calculateTechnicalIndicators(history(ramp(26))).macd, { line: 7, signal: null, histogram: null })
  assert.equal(calculateTechnicalIndicators(history(ramp(33))).macd.signal, null)
  assert.equal(calculateTechnicalIndicators(history(ramp(34))).macd.signal, 7)
  assert.equal(calculateTechnicalIndicators(history(ramp(199))).sma[200], null)
})

test('RSI handles flat and falling markets; Wilder updates use true price gaps', () => {
  assert.equal(calculateTechnicalIndicators(history(Array(15).fill(100))).rsi14, 50)
  assert.equal(calculateTechnicalIndicators(history(ramp(15).reverse())).rsi14, 0)
  const gap = calculateTechnicalIndicators(history([...Array(15).fill(100), 90]))
  assert.equal(gap.rsi14, 0)
  assert.ok(Math.abs(gap.atr14 - (13 * 2 + 11) / 14) < 1e-10)
  const change = calculateTechnicalIndicators(history([...ramp(15), 100]))
  assert.ok(Math.abs(change.rsi14 - 100 * 13 / 27) < 1e-10)
})

test('non-trading-day spacing is accepted; missing observations and invalid bars fail closed', () => {
  assert.ok(calculateTechnicalIndicators(history([100, 110])))
  const data = history([100, 110])
  data.bars[1].tradingDate = '2024-01-06'
  assert.ok(calculateTechnicalIndicators(data))
  assert.equal(calculateTechnicalIndicators({ ...data, completeness: 'missing-observations' }), null)
  assert.equal(calculateTechnicalIndicators(history([])), null)
  assert.equal(calculateTechnicalIndicators({ ...data, bars: data.bars.toReversed() }), null)
  assert.equal(calculateTechnicalIndicators({ ...data, bars: [...data.bars, data.bars[1]] }), null)
  data.bars[1].high = 109
  assert.equal(calculateTechnicalIndicators(data), null)
})

test('price returns clamp month-end, use the prior observation and require a full period', () => {
  const data = history([100, 110, 120, 132])
  const dates = ['2024-01-31', '2024-02-28', '2024-03-01', '2024-03-31']
  data.bars.forEach((bar, index) => { bar.tradingDate = dates[index] })
  const returns = calculatePriceReturns(data)
  assert.equal(returns[1].tradingDate, '2024-02-28')
  assert.ok(Math.abs(returns[1].percent - 20) < 1e-10)
  assert.equal(returns[3], null)
  assert.equal(returns[6], null)
})
