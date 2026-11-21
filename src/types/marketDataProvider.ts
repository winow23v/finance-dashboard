import type { Period, SeriesPoint } from './finance'
import type { EquityMarket, MarketSymbol } from './marketSymbol'

// Provider symbols are mapped by an adapter. Saved favorites keep their exchange and ticker.
export type MarketInstrument =
  | { kind: 'index'; market: EquityMarket; id: string }
  | { kind: 'stock' | 'etf'; listing: MarketSymbol }

// An approval applies to a specific feed and instrument scope, not an entire vendor.
export interface MarketDataApproval {
  providerId: string
  feedId: string
  attribution: { label: string; url: string; notice?: string }
  delivery: {
    publicDisplay: boolean
    publicApiRedistribution: boolean
    advertisingSupportedDisplay: boolean
  }
  cache: { server: MarketDataCachePolicy; browser: MarketDataCachePolicy }
}

type MarketDataCachePolicy = { mode: 'none' } | { mode: 'ttl'; maxAgeMs: number }

export type MarketDataTiming =
  | { kind: 'realtime' }
  | { kind: 'delayed'; minutes: number }
  | { kind: 'end-of-day' }
  | { kind: 'unspecified' }

export type MarketDataQuote = {
  value: number
  currency: 'KRW' | 'USD'
  observation: { kind: 'instant'; at: string } | { kind: 'session'; date: string }
  change: number | null
  percentChange: number | null
}

export type MarketDataResult<T> =
  | { status: 'available'; timing: MarketDataTiming; collectedAt: string; data: T }
  | { status: 'no-observation' | 'unsupported' | 'restricted' | 'provider-error' }

// A future server integration must check approval before fetching, caching, or publishing.
// Unavailable observations stay unavailable. DEMO and official embeds are separate paths.
export interface MarketDataProvider {
  approvalFor(instrument: MarketInstrument, resource: 'quote' | 'history'): MarketDataApproval | undefined
  historyPeriods(instrument: MarketInstrument): readonly Period[]
  quote(instrument: MarketInstrument, signal: AbortSignal): Promise<MarketDataResult<MarketDataQuote>>
  history(instrument: MarketInstrument, period: Period, signal: AbortSignal): Promise<MarketDataResult<readonly SeriesPoint[]>>
}
