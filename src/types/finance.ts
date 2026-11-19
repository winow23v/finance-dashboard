import type { MarketSymbol } from './marketSymbol'

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
