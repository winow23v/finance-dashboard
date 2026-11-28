import type { assessTechnicalTrend, PriceZone } from './technicalAssessment'
import type { TechnicalIndicators } from './technicalIndicators'

type Assessment = ReturnType<typeof assessTechnicalTrend>
type HoldingState = 'unavailable' | 'broken' | 'weakening' | 'intact' | 'mixed'
export type ScenarioPrices = { entry: number; stop: number; target: number }

export const referenceRewardRisk = 2
export const stopAtrBuffer = 0.5

export function calculateRewardRisk({ entry, stop, target }: ScenarioPrices) {
  if (![entry, stop, target].every(price => Number.isFinite(price) && price > 0)
    || stop >= entry || entry >= target) return null
  const reward = target - entry
  const risk = entry - stop
  const ratio = reward / risk
  return Number.isFinite(ratio) ? { ratio, reward, risk } : null
}

function bufferedStop(level: number | undefined, atr: number | null) {
  if (level === undefined || atr === null || !Number.isFinite(atr) || atr <= 0) return null
  const stop = level - stopAtrBuffer * atr
  return Number.isFinite(stop) && stop > 0 && stop < level ? stop : null
}

export function buildTechnicalScenarios(assessment: Assessment, indicators: TechnicalIndicators) {
  const { trend, entry, zones } = assessment
  const { close, atr14, sma, volume } = indicators
  const usable = trend !== 'unavailable'
  const improving = trend === 'up' || trend === 'turn-up'
  const weakening = trend === 'down' || trend === 'turn-down'
  const support = zones.support[0]
  const resistance = zones.resistance[0]
  const brokenSupport = zones.breakDown
  const breakoutZone = zones.breakUp ?? resistance
  const activeRange = zones.testing[0]
  const mode: Assessment['entry'] = !usable ? 'unavailable' : brokenSupport || weakening || entry === 'watch' ? 'watch'
    : entry === 'chase' ? 'chase' : entry
  // An upside breakout is modeled as a retest of the old resistance.
  // In a pullback or a chase, use only a known zone below today's close.
  const candidate: PriceZone | undefined | null = mode === 'breakout' ? breakoutZone
    : mode === 'pullback' || mode === 'chase' ? support : null
  const entryPrice = candidate ? candidate.low + (candidate.high - candidate.low) / 2 : null
  const stop = bufferedStop(candidate?.low, atr14)
  const targetZone = candidate && zones.resistance.find(zone => zone.low > candidate.high)
  const target = targetZone?.low ?? null
  const prices = entryPrice !== null && stop !== null && target !== null ? { entry: entryPrice, stop, target } : null
  const rewardRisk = prices && calculateRewardRisk(prices)
  const shortLevel = brokenSupport?.low ?? (activeRange ?? support)?.low
  const mediumLevel = (zones.support[1] ?? support)?.low
  const mediumReference = sma[50] !== null && sma[50] < close ? sma[50] : undefined
  const state: HoldingState = !usable ? 'unavailable' : brokenSupport ? 'broken' : weakening ? 'weakening'
    : improving ? 'intact' : 'mixed'
  const shortStop = usable ? bufferedStop(shortLevel, atr14) : null
  const mediumStop = usable ? bufferedStop(mediumLevel ?? mediumReference, atr14) : null
  return {
    entry: { mode, candidate, entryPrice, stop, targetZone, rewardRisk, prices: rewardRisk ? prices : null,
      includesTradingCosts: false,
      invalidation: rewardRisk ? { closeAtOrBelow: stop, brokenZoneBelow: candidate?.low } : null,
      unavailableReason: rewardRisk ? null : !candidate ? 'no-entry-zone' : stop === null ? 'no-valid-stop'
        : target === null ? 'no-resistance-target' : 'invalid-price-order',
      breakoutZone, support, volumeThreshold: volume.spikeThreshold, breakoutPassed: !!zones.breakUp && volume.spike === true },
    holding: {
      state, brokenSupport, shortLevel, shortStop, shortBreached: shortStop !== null && close <= shortStop,
      mediumLevel: mediumLevel ?? mediumReference, mediumStop, mediumBreached: mediumStop !== null && close <= mediumStop,
      trimZones: usable ? zones.resistance : [],
      addSupport: usable && improving && !brokenSupport ? support : undefined,
    },
  }
}
