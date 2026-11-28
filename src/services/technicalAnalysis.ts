import type { MarketDailyHistory } from '../types/marketDataProvider'
import { assessTechnicalTrend } from './technicalAssessment.ts'
import { calculateTechnicalIndicators, ohlcvQuality, technicalDivergences, type TechnicalIndicators } from './technicalIndicators.ts'
import type { DivergenceSettings } from './technicalPivots'
import { buildTechnicalScenarios } from './technicalScenarios.ts'

export const technicalFormulaVersion = 1
const maxEntries = 12

type AnalysisSource = {
  market: 'KR' | 'US'
  symbol: string
  collectedAt: string | null
  simulated: boolean
  stale: boolean
  aligned: boolean
  volumeAvailable: boolean
  divergence?: DivergenceSettings
}

function calculateAnalysis(history: MarketDailyHistory, source: AnalysisSource, indicators: TechnicalIndicators | null) {
  const quality = ohlcvQuality(history)
  const assessed = indicators && assessTechnicalTrend(history.bars, indicators)
  const scenarios = assessed && buildTechnicalScenarios(assessed, indicators)
  const divergences = indicators ? technicalDivergences(history, source.divergence) : null
  const common = {
    period: { interval: '1d' as const, from: history.bars[0]?.tradingDate ?? null, through: quality.through,
      observations: quality.observations },
    basis: history.bars.at(-1) ?? null,
    confirmation: indicators ? 'confirmed' as const : 'unverified' as const,
    quality, source,
    intraday: { status: 'provider-unavailable' as const },
  }
  const unavailable = !source.aligned ? 'unaligned-reference'
    : quality.issues[0] ?? 'insufficient-observations'
  function section<T>(used: string[], value: T | null, evidence: string[], reason = unavailable) {
    return { ...common, used, value, evidence, unavailable: value === null ? reason : null }
  }

  const ema = indicators?.ema
  const order = ema && [ema[20], ema[50], ema[100], ema[200]]
  const arrangement = order?.every(value => value !== null) && indicators ? {
    sma: indicators.sma, ema, stability: indicators.smoothing, slope: indicators.sma20Slope,
    emaOrder: order.every((value, index) => index === 0 || order[index - 1]! > value!) ? 'bullish'
      : order.every((value, index) => index === 0 || order[index - 1]! < value!) ? 'bearish' : 'mixed',
    cross: indicators.cross, close: indicators.close,
  } : null
  return {
    ...common, indicators, assessment: assessed, plan: scenarios,
    direction: section(['SMA', 'EMA', 'DMI', 'RSI', 'MACD'],
      assessed && assessed.trend !== 'unavailable' ? assessed.trend : null, assessed?.reasons ?? []),
    strength: section(['ADX14', '+DI14', '-DI14'], indicators?.dmi.adx == null ? null : indicators.dmi,
      ['ADX measures strength', 'DI compares directional pressure']),
    movingAverages: section(['SMA', 'EMA'], arrangement, ['EMA first-window SMA and alpha 2/(n+1)']),
    momentum: section(['RSI14', 'MACD12/26/9'], indicators?.rsi14 == null ? null
      : { rsi: indicators.rsi14, macd: indicators.macd, signalCross: indicators.macdCross, ...indicators.macdDynamics },
      ['RSI uses Wilder smoothing and returns 50 for a flat series', 'MACD compares independently seeded EMAs']),
    volatility: section(['ATR14', 'Bollinger20/2'], indicators?.atr14 == null ? null
      : { atr: indicators.atr14, atrPercent: indicators.atrPercent, bands: indicators.bands },
      ['ATR includes gaps', 'Bollinger bands use population variance']),
    volume: section(['Volume SMA5/20/50', 'Relative volume'], indicators?.volume.latest == null ? null
      : { ...indicators.volume, sma20: indicators.volumeSma20, sma50: indicators.volumeSma50, priceDirection: indicators.priceDirection },
      ['Relative volume uses the previous 20 completed bars'], source.volumeAvailable ? unavailable : 'provider-volume-unavailable'),
    supportResistance: section(['Pivots', 'ATR', 'SMA'], assessed?.zones.structureAvailable
      ? { ...assessed.zones, lines: assessed.priceStructure } : null, ['Pivot confirmation requires two bars on either side']),
    divergence: section(['RSI14', 'MACD12/26', 'Price pivots'], indicators?.macd.line == null ? null : divergences,
      ['Price and indicator pivots align within the configured session tolerance']),
    scenarios: section(['Price zones', 'ATR', 'SMA', 'Relative volume'], scenarios?.entry.prices ? scenarios : null,
      ['A later resistance provides the target', 'The stop is buffered by half an ATR', 'Fees and slippage are excluded'],
      scenarios?.entry.unavailableReason ?? unavailable),
  }
}

const results = new Map<string, ReturnType<typeof calculateAnalysis>>()

export function analyzeDailyHistory(history: MarketDailyHistory, source: AnalysisSource) {
  // Include values so in-place corrections with the same collection timestamp invalidate the result.
  const key = JSON.stringify([technicalFormulaVersion, '1d', source, history], (_, value) =>
    typeof value === 'number' && !Number.isFinite(value) ? String(value) : value)
  const cached = results.get(key)
  if (cached) {
    results.delete(key)
    results.set(key, cached)
    return cached
  }
  const indicators = source.aligned ? calculateTechnicalIndicators(history, { volumeAvailable: source.volumeAvailable }) : null
  const result = calculateAnalysis(history, source, indicators)
  results.set(key, result)
  if (results.size > maxEntries) results.delete(results.keys().next().value!)
  return result
}

export type TechnicalAnalysis = ReturnType<typeof analyzeDailyHistory>
