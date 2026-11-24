import type { MarketSymbol } from './marketSymbol'
import type { MarketDailyHistory } from './marketDataProvider'

export type Market = 'KR' | 'US' | 'FX'
export type Period = '1D' | '1W' | '1M' | '3M' | '1Y'
interface QuoteFields {
  id: string
  name: string
  symbol: string
  market: Market
  currency: 'KRW' | 'USD'
  price: number
  change: number
  percent: number
  asOf: string
  delayed: boolean
}
export type EquityQuote = QuoteFields & MarketSymbol & { kind: 'stock' | 'etf' }
export type Quote = EquityQuote | (QuoteFields & { kind: 'index' | 'fx' })

export interface Indicator {
  id: string
  name: string
  value: number
  unit: '%'
  observationDate: string
  releaseDate: string
  collectedAt: string
}
export interface SeriesPoint {
  at: string
  value: number
}
export interface FinanceSnapshot {
  source: { label: string; simulated: boolean }
  updatedAt: string
  quotes: Quote[]
  indicators: Indicator[]
  marketStatus: Record<'KR' | 'US', 'open' | 'closed'>
  trendTopics: string[]
}

interface IndexFields {
  id: string
  symbol: string
  name: string
  market: 'KR' | 'US'
}

export type MarketIndex = IndexFields & ({
  status: 'available' | 'stale'
  price: number
  change: number | null
  changePercent: number | null
  reason?: KrxReason | 'rate-limited' | null
  observedAt: string
  tradingDate: string
  collectedAt: string
  source: string
} | {
  status: 'unavailable'
  reason: KrxReason | 'no-observation' | 'rate-limited'
  price: null
  change: null
  changePercent: null
  observedAt: null
  tradingDate: null
  collectedAt: null
  source: null
})

export type KrxMarket = 'KOSPI' | 'KOSDAQ'
export type KrxReason = 'provider-not-configured' | 'provider-error' | 'not-published' | 'weekend' | 'before-collection'
export interface KrxStatus {
  status: 'available' | 'stale' | 'unavailable'
  reason: KrxReason | null
  collectedAt: string | null
  source: string
}
export type KrxAfterHours = {
  venue: 'KRX' | 'NXT'
  status: 'market-closed' | 'provider-unavailable' | 'calendar-unavailable'
  tradingDate: string
  scheduledCheckAt: string
  connectionCheckedAt: string | null
  eligibility: 'unknown'
  source: null
  price: null
  observedAt: null
  collectedAt: null
}

export interface KrxStock {
  symbol: string
  name: string
  englishName: string
  market: KrxMarket
  listedOn: string
  shareClass: string
  quote: {
    price: number
    change: number | null
    changePercent: number | null
    volume: number | null
    tradingDate: string
  } | null
}
export interface KrxStocks {
  market: KrxMarket
  listingDate: string | null
  listings: KrxStatus
  trades: KrxStatus
  afterHours?: KrxAfterHours[]
  items: KrxStock[]
}

export interface KrxAnalysis {
  symbol: string
  name: string
  market: KrxMarket
  source: string
  reason: KrxReason | null
  latestDate: string | null
  collectedAt: string | null
  afterHours?: KrxAfterHours[]
  stoppedAt: string | null
  stoppedReason: 'missing-observation' | 'not-collected' | null
  quote: KrxStock['quote']
  history: MarketDailyHistory
}

export interface KrxMarketRow {
  symbol: string
  name: string
  shortName: string
  mapped: boolean
  market: KrxMarket
  price: number
  changePercent: number | null
  volume: number
  marketCap: number | null
}

export interface KrxOverview {
  source: string
  tradingDate: string | null
  collectedAt: string | null
  reason: KrxReason | 'same-date-data-unavailable' | null
  leaders: { advances: KrxMarketRow[]; declines: KrxMarketRow[]; volume: KrxMarketRow[] } | null
  tiles: KrxMarketRow[]
  marketTiles: Record<KrxMarket, KrxMarketRow[]>
}

export interface FredIndicator {
  id: string
  frequency?: 'daily' | 'daily-7-day' | 'monthly'
  seriesId: string
  name: string
  value: number | null
  unit: '%' | 'index'
  observationDate: string | null
  releaseDate: null
  collectedAt: string
  source: { name: 'FRED'; agency: string; url: string }
  stale: boolean | null
  comparisonPeriod?: string | null
  previousObservationDate?: string | null
  change?: number | null
  missingReason?: 'CURRENT_MISSING' | 'COMPARISON_MISSING' | null
}

export interface EconomyIndicators {
  source: { label: 'FRED'; simulated: false }
  indicators: FredIndicator[]
}
