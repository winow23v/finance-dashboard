import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assessTechnicalTrend } from './technicalAssessment.ts'
import { buildTechnicalScenarios, calculateRewardRisk } from './technicalScenarios.ts'
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
  assert.deepEqual(result.sma, { 5: 317, 20: 309.5, 50: 294.5, 60: 289.5, 100: 269.5, 120: 259.5, 200: 219.5, 365: null })
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

test('SMA slope is the difference of two full windows and SMA365 waits for 365 bars', () => {
  const closes = [...Array(20).fill(100), 140]
  const indicators = calculateTechnicalIndicators(history(closes))
  assert.equal(indicators.sma20Slope, 2)
  assert.equal(indicators.sma[20], 102)
  assert.equal(calculateTechnicalIndicators(history(ramp(364))).sma[365], null)
  assert.equal(calculateTechnicalIndicators(history(ramp(365))).sma[365], 282)
})

test('Wilder DMI/ADX warmup, directional dominance and zero range', () => {
  assert.deepEqual(calculateTechnicalIndicators(history(ramp(14))).dmi, { adx: null, plus: null, minus: null })
  assert.deepEqual(calculateTechnicalIndicators(history(ramp(27))).dmi, { adx: null, plus: 50, minus: 0 })
  assert.deepEqual(calculateTechnicalIndicators(history(ramp(28))).dmi, { adx: 100, plus: 50, minus: 0 })
  assert.deepEqual(calculateTechnicalIndicators(history(ramp(28).reverse())).dmi, { adx: 100, plus: 0, minus: 50 })
  const flat = history(Array(28).fill(100))
  for (const bar of flat.bars) bar.low = bar.high = bar.close
  assert.deepEqual(calculateTechnicalIndicators(flat).dmi, { adx: 0, plus: 0, minus: 0 })
})

test('Bollinger population standard deviation and flat-band division', () => {
  assert.equal(calculateTechnicalIndicators(history(ramp(19))).bands, null)
  const { middle, upper, lower, bandwidth, percentB } = calculateTechnicalIndicators(history(ramp(20))).bands
  const sigma = Math.sqrt((20 ** 2 - 1) / 12)
  assert.equal(middle, 109.5)
  assert.equal(upper, middle + 2 * sigma)
  assert.equal(lower, middle - 2 * sigma)
  assert.equal(bandwidth, (upper - lower) / middle * 100)
  assert.equal(percentB, (119 - lower) / (upper - lower) * 100)
  assert.deepEqual(calculateTechnicalIndicators(history(Array(20).fill(100))).bands,
    { middle: 100, lower: 100, upper: 100, bandwidth: 0, percentB: null })
})

test('crosses use the actual sign change including equality bridges, not the first MA ordering', () => {
  assert.equal(calculateTechnicalIndicators(history(ramp(220))).cross.lastEvent, null)
  const data = history([...ramp(200), ...Array(200).fill(50), ...Array(200).fill(500)])
  const reference = []
  let previous = 0
  for (let i = 199; i < data.bars.length; i++) {
    const average = n => data.bars.slice(i - n + 1, i + 1).reduce((sum, bar) => sum + bar.close, 0) / n
    const sign = Math.sign(average(50) - average(200))
    if (sign === 0) continue
    if (previous && previous !== sign) reference.push({ type: sign > 0 ? 'golden' : 'dead', tradingDate: data.bars[i].tradingDate })
    previous = sign
  }
  assert.deepEqual(reference.map(item => item.type), ['dead', 'golden'])
  for (const expected of reference) {
    const prefix = data.bars.filter(bar => bar.tradingDate <= expected.tradingDate)
    assert.deepEqual(calculateTechnicalIndicators({ ...data, bars: prefix }).cross.lastEvent, expected)
    assert.notDeepEqual(calculateTechnicalIndicators({ ...data, bars: prefix.slice(0, -1) }).cross.lastEvent, expected)
  }
})

test('relative volume compares the same confirmed bar with the prior twenty bars and accepts a custom threshold', () => {
  const data = history(ramp(21))
  for (const bar of data.bars.slice(0, -1)) bar.volume = 100
  data.bars[20].volume = 200
  const result = calculateTechnicalIndicators(data, { volumeSpikeThreshold: 2.5 })
  assert.equal(result.tradingDate, data.bars[20].tradingDate)
  assert.equal(result.volumeSma20, 105)
  assert.deepEqual(result.volume, { latest: 200, sma5: 120, prior20: 100, ratio: 2, spikeThreshold: 2.5, spike: false })
  assert.equal(calculateTechnicalIndicators(data).volume.spike, true)
  assert.equal(calculateTechnicalIndicators({ ...data, bars: data.bars.slice(1) }).volume.ratio, null)
  for (const bar of data.bars.slice(0, -1)) bar.volume = 0
  assert.equal(calculateTechnicalIndicators(data).volume.ratio, null)
})

test('corporate-action adjustment is supplied by the provider and no synthetic bars are inserted', () => {
  const adjusted = history(Array(22).fill(100))
  adjusted.bars[21].tradingDate = '2024-01-26'
  const raw = { ...adjusted, adjustment: 'unadjusted', bars: adjusted.bars.map((bar, index) =>
    index < 21 ? { ...bar, open: bar.open * 2, high: bar.high * 2, low: bar.low * 2, close: bar.close * 2 } : bar) }
  const adjustedIndicators = calculateTechnicalIndicators(adjusted)
  const rawIndicators = calculateTechnicalIndicators(raw)
  assert.equal(adjustedIndicators.atr14, 2)
  assert.ok(rawIndicators.atr14 > adjustedIndicators.atr14)
  assert.equal(rawIndicators.tradingDate, adjustedIndicators.tradingDate)
  assert.equal(calculateTechnicalIndicators({ ...raw, completeness: 'missing-observations' }), null)
  for (const invalid of [NaN, Infinity, -1]) {
    const broken = history(ramp(22))
    broken.bars[21].volume = invalid
    assert.equal(calculateTechnicalIndicators(broken), null)
  }
  const tiny = history(Array(220).fill(Number.MIN_VALUE))
  for (const bar of tiny.bars) bar.low = bar.high = bar.close
  function finiteLeaves(object) {
    return Object.values(object).every(value => typeof value === 'object' && value !== null
      ? finiteLeaves(value) : typeof value !== 'number' || Number.isFinite(value))
  }
  assert.ok(finiteLeaves(calculateTechnicalIndicators(tiny)))
})

function assess(data) {
  return assessTechnicalTrend(data.bars, calculateTechnicalIndicators(data))
}

test('trend and risk coexist; sideways and insufficient histories are distinguished', () => {
  const up = assess(history(ramp(220)))
  assert.equal(up.trend, 'up')
  assert.equal(up.entry, 'chase')
  assert.ok(up.risks.includes('RSI 과열 구간'))
  assert.ok(up.invalidation < 319)
  assert.equal(assess(history(ramp(220).reverse())).trend, 'down')
  assert.equal(assess(history(Array(220).fill(100))).trend, 'sideways')
  assert.equal(assess(history(ramp(199))).trend, 'unavailable')
})

test('a swing uses two subsequent bars and a breakout uses only the prior zone', () => {
  const data = history([...Array(24).fill(100), 110, 100, 100, 116])
  const at = end => assess({ ...data, bars: data.bars.slice(0, end) })
  const pivotZones = result => [...result.zones.support, ...result.zones.resistance, ...result.zones.testing]
    .filter(zone => zone.evidence.includes('확정 스윙 고점'))
  assert.equal(pivotZones(at(26)).length, 0)
  assert.equal(pivotZones(at(27)).length, 1)
  assert.equal(pivotZones(at(27))[0].date, data.bars[24].tradingDate)
  const breakout = at(28)
  assert.ok(breakout.zones.breakUp.high < 116)
  assert.ok(breakout.zones.breakUp.evidence.includes('확정 스윙 고점'))
  assert.equal(breakout.breakVolumeConfirmed, false)
  assert.ok(breakout.zones.support.every(zone => zone.high < 116))
})

test('nearby repeated pivots cluster and note high-volume reactions at their own dates', () => {
  const data = history([...Array(23).fill(100), 110, 102, 100, 101, 110, 102, 100, 106])
  data.bars.forEach((bar, i) => { bar.volume = i === 23 || i === 27 ? 500 : 100 })
  const zone = assess(data).zones.resistance.find(level => level.evidence.includes('확정 스윙 고점'))
  assert.equal(zone.reactions, 2)
  assert.equal(zone.volumeReactions, 2)
  assert.equal(zone.strength, 'recent-repeated')
  assert.ok(zone.low < 111 && zone.high > 111)
})

test('mid-term reversal can precede a long-term moving-average cross in either direction', () => {
  const rebound = [...Array.from({ length: 220 }, (_, i) => 400 - i),
    ...Array.from({ length: 25 }, (_, i) => 182 + i)]
  const up = assess(history(rebound))
  const down = assess(history(rebound.map(close => 600 - close)))
  assert.equal(up.trend, 'turn-up')
  assert.equal(down.trend, 'turn-down')
  assert.ok(up.invalidation < rebound.at(-1))
  assert.ok(down.invalidation > 600 - rebound.at(-1))
})

test('Wilder recurrences match TA-Lib on asymmetric ranges and alternating gaps', () => {
  const data = history(Array.from({ length: 45 }, (_, i) => 100 + (i % 9 - 4) * 2 + i * 0.25))
  data.bars.forEach((bar, i) => {
    bar.high = bar.close + 1 + i % 3
    bar.low = bar.close - 1 - i % 4
  })
  const { dmi, atr14, rsi14 } = calculateTechnicalIndicators(data)
  const actual = [dmi.adx, dmi.plus, dmi.minus, atr14, rsi14]
  const reference = [20.029061252556254, 38.320604516313054, 18.993069770053864, 6.03066095978322, 62.84569984387678]
  for (const [i, value] of actual.entries()) assert.ok(Math.abs(value - reference[i]) < 1e-9)
})

test('reward/risk validates positive ordered prices and returns per-unit distances', () => {
  assert.deepEqual(calculateRewardRisk({ entry: 100, stop: 95, target: 110 }), { ratio: 2, risk: 5, reward: 10 })
  assert.deepEqual(calculateRewardRisk({ entry: 1.25, stop: 1, target: 1.5 }), { ratio: 1, risk: 0.25, reward: 0.25 })
  for (const values of [
    [100, 100, 110], [100, 101, 110], [100, 90, 100], [100, 90, 80],
    [0, 90, 110], [100, -1, 110], [100, 90, NaN], [Infinity, 90, 110],
    [Number.MIN_VALUE * 2, Number.MIN_VALUE, Number.MAX_VALUE],
  ]) {
    const [entry, stop, target] = values
    assert.equal(calculateRewardRisk({ entry, stop, target }), null)
  }
})

const scenarioZone = (low, high) => ({
  low, high, date: '2024-08-06', reactions: 2, volumeReactions: 1, strength: 'recent-repeated', evidence: ['확정 스윙'],
})

test('pullback uses its range, buffered stop and nearer resistance edge', () => {
  const data = history(ramp(220))
  const indicators = calculateTechnicalIndicators(data)
  const assessment = assess(data)
  const support = scenarioZone(304, 306)
  const second = scenarioZone(294, 298)
  const target = scenarioZone(325, 330)
  const plan = buildTechnicalScenarios({ ...assessment, entry: 'pullback',
    zones: { ...assessment.zones, support: [support, second], resistance: [target], testing: [], breakDown: null } }, indicators)
  assert.equal(plan.entry.candidate, support)
  assert.deepEqual(plan.entry.prices, { entry: 305, stop: 303, target: 325 })
  assert.deepEqual(plan.entry.rewardRisk, { ratio: 10, reward: 20, risk: 2 })
  assert.equal(plan.holding.state, 'intact')
  assert.equal(plan.holding.shortStop, 303)
  assert.equal(plan.holding.mediumStop, 293)
  assert.deepEqual(plan.holding.trimZones, [target])
  assert.equal(plan.holding.addSupport, support)
})

test('breakout retest needs a higher resistance for target and volume for confirmation', () => {
  const data = history(ramp(220))
  data.bars.at(-1).volume = 1000
  const indicators = calculateTechnicalIndicators(data)
  const assessment = assess(data)
  const oldResistance = scenarioZone(308, 310)
  const retest = { ...assessment, entry: 'breakout',
    zones: { ...assessment.zones, breakUp: oldResistance, breakDown: null, resistance: [] } }
  const noTarget = buildTechnicalScenarios(retest, indicators)
  assert.equal(noTarget.entry.breakoutPassed, true)
  assert.equal(noTarget.entry.candidate, oldResistance)
  assert.equal(noTarget.entry.targetZone, undefined)
  assert.equal(noTarget.entry.rewardRisk, null)
  const target = scenarioZone(331, 333)
  const armed = buildTechnicalScenarios({ ...retest, zones: { ...retest.zones, resistance: [target] } },
    { ...indicators, volume: { ...indicators.volume, spike: false } })
  assert.equal(armed.entry.breakoutPassed, false)
  assert.deepEqual(armed.entry.prices, { entry: 309, stop: 307, target: 331 })
})

test('broken support overrides entries and flags an already breached holding threshold', () => {
  const data = history(ramp(220))
  const indicators = calculateTechnicalIndicators(data)
  const assessment = assess(data)
  const broken = scenarioZone(323, 326)
  const result = buildTechnicalScenarios({ ...assessment, zones: { ...assessment.zones, breakDown: broken } }, indicators)
  assert.equal(result.entry.mode, 'watch')
  assert.equal(result.entry.prices, null)
  assert.equal(result.holding.state, 'broken')
  assert.equal(result.holding.shortStop, 322)
  assert.equal(result.holding.shortBreached, true)
  assert.equal(result.holding.addSupport, undefined)
})

test('insufficient history and zero ATR do not create stop or reward/risk candidates', () => {
  const data = history(ramp(199))
  const short = buildTechnicalScenarios(assess(data), calculateTechnicalIndicators(data))
  assert.equal(short.entry.mode, 'unavailable')
  assert.equal(short.entry.prices, null)
  assert.equal(short.holding.state, 'unavailable')
  assert.equal(short.holding.shortStop, null)
  const enough = history(ramp(220))
  const plan = buildTechnicalScenarios(assess(enough), { ...calculateTechnicalIndicators(enough), atr14: 0 })
  assert.equal(plan.entry.stop, null)
  assert.equal(plan.entry.rewardRisk, null)
  assert.equal(plan.holding.mediumStop, null)
})
