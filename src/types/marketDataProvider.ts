import type { Period, SeriesPoint } from './finance'
import type { EquityMarket, MarketSymbol } from './marketSymbol'

// Provider symbols are mapped by an adapter. Saved favorites keep their exchange and ticker.
export type MarketInstrument =
  | { kind: 'index'; market: EquityMarket; id: string; exchange: string; symbol: string }
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

export type MarketDataLicense =
  | { status: 'unverified' | 'restricted' | 'not-applicable' }
  | { status: 'verified'; approval: MarketDataApproval }

export type MarketDataDisplay =
  | { status: 'allowed'; audience: 'public' | 'private' }
  | { status: 'blocked' }

export type MarketDataResult<T> =
  | {
    status: 'available'
    instrument: MarketInstrument
    source: { providerId: string; label: string; simulated: boolean }
    timing: MarketDataTiming
    collectedAt: string
    refreshIntervalMs: number | null
    license: MarketDataLicense
    display: MarketDataDisplay
    data: T
  }
  | { status: 'no-observation' | 'unsupported' | 'restricted' | 'provider-error' }

// A future server integration must check approval before fetching, caching, or publishing.
// Unavailable observations stay unavailable. DEMO records remain explicitly labeled.
export interface MarketDataProvider {
  approvalFor(instrument: MarketInstrument, resource: 'quote' | 'history'): MarketDataApproval | undefined
  historyPeriods(instrument: MarketInstrument): readonly Period[]
  quote(instrument: MarketInstrument, signal: AbortSignal): Promise<MarketDataResult<MarketDataQuote>>
  history(instrument: MarketInstrument, period: Period, signal: AbortSignal): Promise<MarketDataResult<readonly SeriesPoint[]>>
}
