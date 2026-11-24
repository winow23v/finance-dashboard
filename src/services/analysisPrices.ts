import type { KrxMarket, KrxStocks } from '../types/finance'

export type AnalysisUnit = 'KRW' | 'USD' | 'pt'
type Direction = 'down' | 'up'
type TickSchedule = 'stock'
export type PriceDisplay = { unit: AnalysisUnit; tick?: TickSchedule }

const effectiveDate = '2023-01-25'
const krxStockClasses = new Set(['보통주', '우선주', '구형우선주', '신형우선주', '종류주권'])
const bands = [[2000, 1], [5000, 5], [20000, 10], [50000, 50], [200000, 100], [500000, 500], [Infinity, 1000]] as const
const positive = (value: number) => Number.isFinite(value) && value > 0

// The existing KRX stock catalog confirms share classes. An unknown or outdated
// class, including other product types, must never inherit the stock schedule.
export function confirmedKrxTick(listing: KrxStocks, market: KrxMarket, symbol: string, date: string): TickSchedule | undefined {
  if (listing.market !== market || listing.listings.status === 'unavailable' || !listing.listingDate
    || listing.listingDate < date || date < effectiveDate) return
  const matches = listing.items.filter(row => row.symbol === symbol && row.market === market && row.listedOn <= date)
  if (matches.length !== 1) return
  if (krxStockClasses.has(matches[0].shareClass)) return 'stock'
}

export function krxTickSize(price: number) {
  if (!positive(price)) return null
  return bands.find(([upper]) => price < upper)?.[1] ?? null
}

const integers = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 0 })
const decimals = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 2 })
const rates = new Intl.NumberFormat('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const raw = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 20 })
const cents = new Intl.NumberFormat('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const subDollar = new Intl.NumberFormat('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 4 })

export const formatMetric = (value?: number | null) => value == null || !Number.isFinite(value) ? '자료 부족' : decimals.format(value)
export const formatPercent = (value: number) => Number.isFinite(value) ? rates.format(value) + '%' : '자료 부족'
export const formatVolume = (value?: number | null) => value == null || !Number.isFinite(value) || value < 0 ? '자료 부족' : integers.format(value)

export function formatAnalysisPrice(value: number | null | undefined, unit: AnalysisUnit) {
  if (value == null || !Number.isFinite(value) || value < 0) return '자료 부족'
  if (unit === 'KRW') return raw.format(value) + '원'
  return (unit === 'USD' ? (value < 1 ? subDollar : cents) : decimals).format(value) + ' ' + unit
}

function displayPrice(value: number | null, { unit, tick }: PriceDisplay, direction: Direction) {
  if (value === null || !positive(value) || value > Number.MAX_SAFE_INTEGER) return null
  const size = unit === 'KRW' && tick ? krxTickSize(value) : null
  const scale = unit === 'USD' ? (value < 1 ? 10000 : 100) : unit === 'pt' ? 100 : 1
  const scaled = size ? value / size : value * scale
  // Normalize binary arithmetic close to an exact cent before directed rounding.
  const near = Math.round(scaled)
  const amount = Math.abs(scaled - near) <= Number.EPSILON * Math.abs(scaled) * 2 ? near : scaled
  const rounded = direction === 'down' ? Math.floor(amount) : Math.ceil(amount)
  const result = size ? rounded * size : rounded / scale
  return Number.isSafeInteger(rounded) && positive(result) ? result : null
}

export function displayZone(zone: { low: number; high: number }, display: PriceDisplay) {
  if (!positive(zone.low) || !positive(zone.high) || zone.low > zone.high) return null
  const low = displayPrice(zone.low, display, 'down')
  const high = displayPrice(zone.high, display, 'up')
  return low !== null && high !== null && low <= high ? { low, high } : null
}

export function formatZone(zone: { low: number; high: number }, display: PriceDisplay) {
  const result = displayZone(zone, display)
  return result ? [result.low, result.high].map(price => formatAnalysisPrice(price, display.unit)).join(' ~ ') : '표시 범위 확인 불가'
}

export function formatThreshold(price: number | null | undefined, display: PriceDisplay, direction: Direction = 'down') {
  return formatAnalysisPrice(displayPrice(price ?? null, display, direction), display.unit)
}

export function displayScenarioPrices(prices: { entry: number | null; stop: number | null; target: number | null }, display: PriceDisplay) {
  // For a long scenario, round entry up and stop/target down. This avoids
  // improving the displayed reward/risk by using a more favorable price.
  const entry = displayPrice(prices.entry, display, 'up')
  const stop = displayPrice(prices.stop, display, 'down')
  const target = displayPrice(prices.target, display, 'down')
  const values = entry !== null && stop !== null && target !== null ? { entry, stop, target } : null
  return { entry, stop, target, prices: values }
}

export const pricePolicy = ({ unit, tick }: PriceDisplay) => unit === 'KRW'
  ? tick ? 'KRX 호가 간격을 적용한 분석 후보' : '호가 미확인 · 원 단위 분석 표시'
  : unit === 'USD' ? '달러 단위 분석 표시 · 거래소 호가 미적용' : '지수 포인트 분석 표시'
