import type { DailyOhlcvBar } from '../types/marketDataProvider'
import type { TechnicalIndicators } from './technicalIndicators'

const pivotRadius = 2
const levelWindows = [20, 60, 120] as const
type Evidence = { price: number; date: string; index: number; label: string; pivot: boolean; volumeSpike: boolean }
export type PriceZone = {
  low: number; high: number; date: string; evidence: string[]
  reactions: number; volumeReactions: number; strength: 'single' | 'repeated' | 'recent-repeated'
}

function buildZones(prior: readonly DailyOhlcvBar[], confirmation: readonly DailyOhlcvBar[], atr: number,
  sma: TechnicalIndicators['prior']['sma'], volumeThreshold: number) {
  const evidence: Evidence[] = []
  function add(index: number, price: number, label: string, pivot = false) {
    const bar = prior[index]
    const earlierVolume = pivot && index >= 20
      ? prior.slice(index - 20, index).reduce((sum, row) => sum + row.volume, 0) / 20 : 0
    evidence.push({ index, price, date: bar.tradingDate, label, pivot,
      volumeSpike: earlierVolume > 0 && bar.volume / earlierVolume >= volumeThreshold })
  }

  for (let i = Math.max(pivotRadius, prior.length - 120); i < confirmation.length - pivotRadius; i++) {
    const bar = prior[i]
    const neighbors = [...prior.slice(i - pivotRadius, i), ...confirmation.slice(i + 1, i + 1 + pivotRadius)]
    if (neighbors.every(neighbor => bar.high > neighbor.high)) add(i, bar.high, '확정 스윙 고점', true)
    if (neighbors.every(neighbor => bar.low < neighbor.low)) add(i, bar.low, '확정 스윙 저점', true)
  }
  for (const period of levelWindows) {
    const start = prior.length - period
    if (start < 0) continue
    let high = start
    let low = start
    for (let i = start + 1; i < prior.length; i++) {
      if (prior[i].high >= prior[high].high) high = i
      if (prior[i].low <= prior[low].low) low = i
    }
    add(high, prior[high].high, `${period}거래일 고점`)
    add(low, prior[low].low, `${period}거래일 저점`)
  }
  for (const period of [20, 50, 200]) {
    if (sma[period] !== null) add(prior.length - 1, sma[period], `직전 SMA ${period}`)
  }

  const groups: Evidence[][] = []
  const tolerance = atr * 0.5
  for (const point of evidence.sort((a, b) => a.price - b.price)) {
    const group = groups.at(-1)
    if (group && point.price - group[0].price <= tolerance) group.push(point)
    else groups.push([point])
  }
  return groups.map((group): PriceZone => {
    const pivots = [...new Set(group.filter(point => point.pivot).map(point => point.index))]
    const recent = pivots.some(index => prior.length - index <= 20)
    return {
      low: Math.max(0, group[0].price - atr * 0.15), high: group[group.length - 1].price + atr * 0.15,
      date: group.reduce((latest, point) => point.date > latest ? point.date : latest, group[0].date),
      evidence: [...new Set(group.map(point => point.label))], reactions: pivots.length,
      volumeReactions: new Set(group.filter(point => point.volumeSpike).map(point => point.index)).size,
      strength: pivots.length >= 2 ? (recent ? 'recent-repeated' : 'repeated') : 'single',
    }
  })
}

function structure(bars: readonly DailyOhlcvBar[], indicators: TechnicalIndicators) {
  const last = bars.at(-1)
  const previous = bars.at(-2)
  const empty = { structureAvailable: false, support: [], resistance: [], testing: [], breakUp: null, breakDown: null }
  const { atr14: atr, sma } = indicators.prior
  if (!last || !previous || bars.length <= 20 || atr === null || atr <= 0) return empty
  const prior = bars.slice(0, -1)
  const threshold = indicators.volume.spikeThreshold
  const zones = buildZones(prior, bars, atr, sma, threshold)
  // The breakout baselines cannot incorporate a pivot confirmed on the breakout bar.
  const previousZones = buildZones(prior, prior, atr, sma, threshold)
  const historical = (zone: PriceZone) => zone.evidence.some(label => !label.startsWith('직전 SMA'))
  return {
    structureAvailable: true,
    support: zones.filter(zone => zone.high < last.close).reverse().slice(0, 2),
    resistance: zones.filter(zone => zone.low > last.close).slice(0, 2),
    testing: zones.filter(zone => zone.low <= last.close && zone.high >= last.close),
    breakUp: previousZones.filter(zone => historical(zone) && previous.close <= zone.high && last.close > zone.high).at(-1) ?? null,
    breakDown: previousZones.find(zone => historical(zone) && previous.close >= zone.low && last.close < zone.low) ?? null,
  }
}

export function priceStructure(bars: readonly DailyOhlcvBar[]) {
  const highs: { index: number; price: number; date: string }[] = []
  const lows: typeof highs = []
  for (let index = Math.max(pivotRadius, bars.length - 120); index < bars.length - pivotRadius; index++) {
    const bar = bars[index]
    const neighbors = [...bars.slice(index - pivotRadius, index), ...bars.slice(index + 1, index + 1 + pivotRadius)]
    if (neighbors.every(row => row.high < bar.high)) highs.push({ index, price: bar.high, date: bar.tradingDate })
    if (neighbors.every(row => row.low > bar.low)) lows.push({ index, price: bar.low, date: bar.tradingDate })
  }
  const line = (anchors: typeof highs) => {
    const [from, to] = anchors.slice(-2)
    if (!to) return null
    const slope = (to.price - from.price) / (to.index - from.index)
    return { from, to, slope, latest: to.price + slope * (bars.length - 1 - to.index) }
  }
  const upper = line(highs)
  const lower = line(lows)
  const channel = upper && lower && lower.latest > 0 && upper.latest > lower.latest &&
    Math.sign(upper.slope) === Math.sign(lower.slope) ? { upper: upper.latest, lower: lower.latest } : null
  return { upper, lower, channel }
}

type Trend = 'up' | 'down' | 'sideways' | 'turn-up' | 'turn-down' | 'unavailable'
type Entry = 'pullback' | 'breakout' | 'chase' | 'watch' | 'unavailable'

export function assessTechnicalTrend(bars: readonly DailyOhlcvBar[], indicators: TechnicalIndicators) {
  const { sma, ema, dmi, bands, macd, rsi14, atr14, volume, close, tradingDate } = indicators
  const zones = structure(bars, indicators)
  const longUp = sma[50] !== null && sma[200] !== null && sma[50] > sma[200]
  const longDown = sma[50] !== null && sma[200] !== null && sma[50] < sma[200]
  const emaUp = ema[20] !== null && ema[50] !== null && ema[200] !== null && ema[20] > ema[50] && ema[50] > ema[200]
  const emaDown = ema[20] !== null && ema[50] !== null && ema[200] !== null && ema[20] < ema[50] && ema[50] < ema[200]
  const midUp = sma[20] !== null && sma[50] !== null && close > sma[20] && sma[20] > sma[50]
  const midDown = sma[20] !== null && sma[50] !== null && close < sma[20] && sma[20] < sma[50]
  const bullish = dmi.plus !== null && dmi.minus !== null && dmi.plus > dmi.minus
  const bearish = dmi.plus !== null && dmi.minus !== null && dmi.plus < dmi.minus
  const momentumUp = macd.histogram !== null && rsi14 !== null && macd.histogram > 0 && rsi14 > 50
  const momentumDown = macd.histogram !== null && rsi14 !== null && macd.histogram < 0 && rsi14 < 50
  let trend: Trend = 'unavailable'
  if (sma[200] !== null && dmi.adx !== null) {
    if (dmi.adx >= 25 && longUp && emaUp && midUp && bullish) trend = 'up'
    else if (dmi.adx >= 25 && longDown && emaDown && midDown && bearish) trend = 'down'
    else if (dmi.adx >= 20 && !longUp && midUp && bullish && momentumUp) trend = 'turn-up'
    else if (dmi.adx >= 20 && !longDown && midDown && bearish && momentumDown) trend = 'turn-down'
    else trend = 'sideways'
  }

  const extended = sma[20] !== null && atr14 !== null && atr14 > 0
    ? (close - sma[20]) / atr14 : null
  const overheat = rsi14 !== null && rsi14 >= 70
  const aboveBand = bands !== null && close > bands.upper
  const chase = (extended !== null && extended >= 2) || (overheat && aboveBand)
  let entry: Entry = 'watch'
  if (trend === 'unavailable') entry = 'unavailable'
  else if (chase) entry = 'chase'
  else if (zones.breakUp || (trend !== 'down' && trend !== 'turn-down' && zones.resistance[0] && atr14 !== null
    && zones.resistance[0].low - close <= atr14)) entry = 'breakout'
  else if (trend === 'up' || trend === 'turn-up') entry = 'pullback'

  const reasons = [
    (longUp ? 'SMA 50이 SMA 200 위' : longDown ? 'SMA 50이 SMA 200 아래'
      : sma[200] === null ? 'SMA 200 산출 자료 부족' : 'SMA 50과 SMA 200이 같은 수준')
      + (emaUp ? ' · EMA 정배열' : emaDown ? ' · EMA 역배열' : sma[200] === null ? '' : ' · EMA 배열 혼재'),
    midUp ? '종가와 SMA 20이 SMA 50 위' : midDown ? '종가와 SMA 20이 SMA 50 아래' : '종가와 중기 이동평균 방향이 엇갈림',
    dmi.adx === null ? 'ADX 산출 자료 부족' : `ADX ${dmi.adx.toFixed(1)} · ${bullish ? '+DI 우세' : bearish ? '−DI 우세' : 'DI 균형'}`,
    momentumUp ? 'RSI 50 초과 및 MACD 시그널 위' : momentumDown ? 'RSI 50 미만 및 MACD 시그널 아래'
      : macd.histogram === null || rsi14 === null ? '모멘텀 산출 자료 부족' : 'RSI와 MACD의 방향 확인이 제한적',
    volume.ratio === null ? '직전 20거래일 대비 거래량 비교 불가'
      : `확정 거래량이 직전 20거래일 평균의 ${volume.ratio.toFixed(2)}배 · ${volume.spike ? '급증 기준 충족' : '급증 기준 미달'}`,
  ]
  const risks = [
    ...(overheat ? ['RSI 과열 구간'] : []),
    ...(aboveBand ? ['볼린저 상단 초과'] : []),
    ...(extended !== null && extended >= 2 ? ['SMA 20 대비 2 ATR 이상 상승 이격'] : []),
    ...(extended !== null && extended <= -2 ? ['SMA 20 대비 2 ATR 이상 하락 이격'] : []),
    ...(zones.breakDown ? ['직전 가격 구간 하단 종가 이탈'] : []),
  ]
  const invalidation = trend === 'up' || trend === 'turn-up' ? zones.support[0]?.low
    : trend === 'down' || trend === 'turn-down' ? zones.resistance[0]?.high : undefined
  return { tradingDate, trend, entry, reasons, risks, zones, invalidation, priceStructure: priceStructure(bars),
    breakVolumeConfirmed: zones.breakUp || zones.breakDown ? volume.spike : null }
}
