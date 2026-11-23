import { fetchForMember } from '../services/memberTransport'
import { isWatchlistSymbol } from '../services/watchlist'
import type { MarketSymbol } from '../types/marketSymbol'

async function request(userId: string, path: string, signal: AbortSignal, options?: RequestInit) {
  const response = await fetchForMember(userId, '/api/v1/watchlist' + path, {
    ...options, signal: AbortSignal.any([signal, AbortSignal.timeout(12_000)]),
  })
  if (!response.ok) throw new Error('Watchlist request failed: ' + response.status)
  return response
}

export const cloudFavorites = {
  async load(userId: string, signal: AbortSignal) {
    const { items } = await (await request(userId, '', signal)).json()
    if (!Array.isArray(items) || !items.every(isWatchlistSymbol)) throw new Error('Invalid watchlist response')
    return items as MarketSymbol[]
  },
  async add(userId: string, items: MarketSymbol[], signal: AbortSignal) {
    await request(userId, '', signal, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items }),
    })
  },
  async remove(userId: string, item: MarketSymbol, signal: AbortSignal) {
    const path = [item.market, item.exchange, item.symbol].map(encodeURIComponent).join('/')
    await request(userId, '/' + path, signal, { method: 'DELETE' })
  },
}
