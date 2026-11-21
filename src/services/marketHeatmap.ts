import type { MarketDataQuote, MarketDataTiming } from '../types/marketDataProvider'
import type { EquityMarket, MarketSymbol } from '../types/marketSymbol'

export const maxHeatmapListings = 60

export interface HeatmapSource {
  label: string
  url: string
  collectedAt: string
  refreshIntervalMs: number | null
  publicDisplay: true
  publicApiRedistribution: true
  attributionNotice?: string
}

export interface HeatmapListing {
  listing: MarketSymbol
  name: string
  sector: string
  marketCap: number
  marketCapCurrency: 'KRW' | 'USD'
  marketCapDate: string
  classificationDate: string
  previousTradingDate: string
  quote: MarketDataQuote & { percentChange: number; previousClose: number }
}

export interface MarketHeatmapSnapshot {
  market: EquityMarket
  tradingDate: string
  session: 'open' | 'closed' | 'holiday'
  timing: Exclude<MarketDataTiming, { kind: 'unspecified' }>
  adjustment: 'unadjusted' | 'split-adjusted'
  sources: { quote: HeatmapSource; marketCap: HeatmapSource; sector: HeatmapSource }
  listings: readonly HeatmapListing[]
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}
function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 160
}
function instant(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value))
}
function date(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString().startsWith(value)
}
function source(value: unknown): value is HeatmapSource {
  if (!record(value) || !text(value.label) || typeof value.url !== 'string' ||
    !instant(value.collectedAt) || !(value.refreshIntervalMs === null || positive(value.refreshIntervalMs)) ||
    value.publicDisplay !== true || value.publicApiRedistribution !== true ||
    !(value.attributionNotice === undefined || text(value.attributionNotice))) return false
  try {
    const url = new URL(value.url)
    return url.protocol === 'https:' && !url.username && !url.password
  } catch { return false }
}

// Permissions in the response are assertions made by an approved server adapter.
// Reject the whole snapshot if a missing weight or duplicate would distort the partition.
export function parseMarketHeatmap(value: unknown, market: EquityMarket): MarketHeatmapSnapshot | null {
  if (!record(value) || value.market !== market || !date(value.tradingDate) ||
    (value.session !== 'open' && value.session !== 'closed' && value.session !== 'holiday') ||
    (value.adjustment !== 'unadjusted' && value.adjustment !== 'split-adjusted') ||
    !record(value.timing) || (value.timing.kind !== 'realtime' && value.timing.kind !== 'end-of-day' &&
      !(value.timing.kind === 'delayed' && positive(value.timing.minutes))) ||
    (value.session === 'holiday' && value.timing.kind !== 'end-of-day') ||
    !record(value.sources) || !source(value.sources.quote) || !source(value.sources.marketCap) || !source(value.sources.sector) ||
    !Array.isArray(value.listings) || !value.listings.length || value.listings.length > maxHeatmapListings) return null
  const keys = new Set<string>()
  const sessionDate = value.tradingDate
  const quoteCollectedAt = Date.parse(value.sources.quote.collectedAt)
  let previousTradingDate: string | undefined
  let marketCapDate: string | undefined
  const dates = new Map<string, Intl.DateTimeFormat>()
  function localDate(at: string, timeZone: string) {
    try {
      const format = dates.get(timeZone) ?? new Intl.DateTimeFormat('sv-SE', { timeZone, dateStyle: 'short' })
      dates.set(timeZone, format)
      return format.format(new Date(at))
    } catch { return null }
  }
  for (const item of value.listings) {
    if (!record(item) || !record(item.listing) || !text(item.name) || !text(item.sector) ||
      !positive(item.marketCap) || !Number.isSafeInteger(item.marketCap) || !date(item.marketCapDate) ||
      (item.marketCapDate !== sessionDate && item.marketCapDate !== item.previousTradingDate) ||
      !date(item.classificationDate) || item.classificationDate > sessionDate ||
      !date(item.previousTradingDate) || item.previousTradingDate >= sessionDate ||
      item.listing.market !== market || typeof item.listing.exchange !== 'string' || !/^[A-Z0-9_-]{1,24}$/.test(item.listing.exchange) ||
      typeof item.listing.symbol !== 'string' || !/^[A-Z0-9._-]{1,32}$/.test(item.listing.symbol) ||
      !record(item.quote) || !positive(item.quote.value) || !positive(item.quote.previousClose) || item.quote.tradingDate !== sessionDate ||
      item.quote.currency !== (market === 'KR' ? 'KRW' : 'USD') || item.marketCapCurrency !== item.quote.currency || !text(item.quote.timeZone) ||
      typeof item.quote.percentChange !== 'number' || !Number.isFinite(item.quote.percentChange) ||
      !(item.quote.change === null || (typeof item.quote.change === 'number' && Number.isFinite(item.quote.change))) ||
      !record(item.quote.observation)) return null
    if ((previousTradingDate && previousTradingDate !== item.previousTradingDate) ||
      (marketCapDate && marketCapDate !== item.marketCapDate)) return null
    previousTradingDate = item.previousTradingDate
    marketCapDate = item.marketCapDate
    const expectedPercent = (item.quote.value / item.quote.previousClose - 1) * 100
    if (Math.abs(item.quote.percentChange - expectedPercent) > 0.03) return null
    const observation = item.quote.observation
    const collectedDate = localDate(value.sources.quote.collectedAt, item.quote.timeZone)
    if (!collectedDate || collectedDate < sessionDate) return null
    if (observation.kind === 'session') {
      if (value.timing.kind !== 'end-of-day' || observation.date !== sessionDate) return null
    } else if (observation.kind !== 'instant' || !instant(observation.at) || Date.parse(observation.at) > quoteCollectedAt ||
      localDate(observation.at, item.quote.timeZone) !== sessionDate) return null
    const key = item.listing.exchange + ':' + item.listing.symbol
    if (keys.has(key)) return null
    keys.add(key)
  }
  return value as unknown as MarketHeatmapSnapshot
}

const palettes = {
  KR: { up: ['#AD4248', '#D83B3D', '#E93636'], flat: '#414B58', down: ['#38557C', '#3264A4', '#377FCF'] },
  US: { up: ['#307E52', '#30A65A', '#2CC95C'], flat: '#45505C', down: ['#854950', '#BB434B', '#E63238'] },
}

export function heatmapColor(market: EquityMarket, percent: number) {
  const palette = palettes[market]
  if (percent === 0) return palette.flat
  const magnitude = Math.min(3, Math.abs(percent))
  return palette[percent > 0 ? 'up' : 'down'][magnitude === 3 ? 2 : magnitude >= 1.5 ? 1 : 0]
}

export function heatmapTextColor(hex: string) {
  const channels = [1, 3, 5].map(index => Number.parseInt(hex.slice(index, index + 2), 16) / 255)
    .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
  const luminance = channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
  return luminance > 0.179 ? '#000' : '#fff'
}

export type HeatmapRect = { x: number; y: number; width: number; height: number }

// Binary partition of the longer side keeps areas proportional without a layout dependency.
export function layoutHeatmap<T>(rows: readonly T[], weight: (row: T) => number, rect: HeatmapRect = { x: 0, y: 0, width: 100, height: 100 }) {
  const sorted = rows.map(row => ({ row, weight: weight(row) })).sort((a, b) => b.weight - a.weight)
  const total = sorted.reduce((sum, item) => sum + item.weight, 0)
  if (!Number.isFinite(total) || sorted.some(item => !positive(item.weight))) return []
  const layout: { row: T; rect: HeatmapRect }[] = []

  function partition(items: typeof sorted, bounds: HeatmapRect, sum: number) {
    if (items.length === 1) { layout.push({ row: items[0].row, rect: bounds }); return }
    let split = 1
    let leftSum = items[0].weight
    while (split < items.length - 1 && Math.abs(sum / 2 - leftSum - items[split].weight) < Math.abs(sum / 2 - leftSum)) {
      leftSum += items[split++].weight
    }
    const ratio = leftSum / sum
    if (bounds.width >= bounds.height) {
      const width = bounds.width * ratio
      partition(items.slice(0, split), { ...bounds, width }, leftSum)
      partition(items.slice(split), { ...bounds, x: bounds.x + width, width: bounds.width - width }, sum - leftSum)
    } else {
      const height = bounds.height * ratio
      partition(items.slice(0, split), { ...bounds, height }, leftSum)
      partition(items.slice(split), { ...bounds, y: bounds.y + height, height: bounds.height - height }, sum - leftSum)
    }
  }

  if (sorted.length) partition(sorted, rect, total)
  return layout
}
