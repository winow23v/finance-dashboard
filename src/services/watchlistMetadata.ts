import { isNumber, isRecord } from './apiFinanceService'
import { fetchMemberApi } from './memberTransport'
import { findMarketListing, marketListings } from './marketListings'
import { isWatchlistSymbol } from './watchlist'
import { marketSymbolKey, type MarketSymbol } from '../types/marketSymbol'
import type { KrxStock } from '../types/finance'

export type Observation = {
  name?: string; segment?: string; currency?: 'KRW' | 'USD'
  quote?: { price: number; changePercent: number | null; tradingDate: string }
}

export function registeredObservation(listing: MarketSymbol): Observation {
  const registered = findMarketListing(listing) ?? (listing.market === 'US' && listing.exchange === 'US'
    ? marketListings.find(entry => entry.listing.market === 'US' && entry.listing.symbol === listing.symbol) : undefined)
  const venues: Record<string, string> = { XNAS: 'NASDAQ', XNYS: 'NYSE', ARCX: 'NYSE Arca' }
  return {
    name: registered?.name,
    segment: registered ? venues[registered.listing.exchange] : undefined,
    currency: registered?.currency,
  }
}

export function krxObservation(stock: KrxStock): Observation {
  return { name: stock.name, segment: stock.market, currency: 'KRW', quote: stock.quote ?? undefined }
}

export async function watchlistObservations(items: MarketSymbol[], signal: AbortSignal) {
  const response = await fetchMemberApi('/api/v1/market/watchlist/observations', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
  })
  if (!response.ok) throw new Error('Watchlist metadata request failed')
  const data: unknown = await response.json()
  if (!isRecord(data) || !Array.isArray(data.items)) throw new Error('Invalid observation response')
  const requested = new Set(items.map(marketSymbolKey))
  const entries = new Map<string, Observation>()
  for (const row of data.items) {
    if (!isRecord(row) || !isWatchlistSymbol(row.listing)) continue
    const key = marketSymbolKey(row.listing)
    if (!requested.has(key)) continue
    const quote = row.quote
    const observation: Observation = {}
    if (isRecord(quote) && isNumber(quote.price) && quote.price > 0
      && (quote.changePercent === null || isNumber(quote.changePercent))
      && typeof quote.tradingDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(quote.tradingDate)) {
      observation.quote = { price: quote.price, changePercent: quote.changePercent, tradingDate: quote.tradingDate }
    }
    if (row.listing.market === 'KR' && typeof row.name === 'string' && row.name.trim()
      && row.name !== row.listing.symbol && (row.segment === 'KOSPI' || row.segment === 'KOSDAQ') && row.currency === 'KRW') {
      entries.set(key, { ...observation, name: row.name, segment: row.segment, currency: 'KRW' })
    } else if (row.listing.market === 'US' && row.currency === 'USD'
      && (row.listing.exchange === 'US' || findMarketListing(row.listing))) {
      entries.set(key, { ...observation, currency: 'USD' })
    }
  }
  return entries
}
