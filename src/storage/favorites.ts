import { marketSymbolKey, type MarketSymbol } from '../types/marketSymbol'

export interface FavoriteRepository<Load, Save> {
  load(): Load
  save(items: readonly MarketSymbol[]): Save
}

export function mergeFavorites(...lists: readonly (readonly MarketSymbol[])[]): MarketSymbol[] {
  const unique = new Map<string, MarketSymbol>()
  for (const symbol of lists.flat()) {
    const key = marketSymbolKey(symbol)
    if (!unique.has(key)) unique.set(key, {
      market: symbol.market,
      exchange: symbol.exchange.trim().toUpperCase(),
      symbol: symbol.symbol.trim().toUpperCase(),
    })
  }
  return [...unique.values()]
}
