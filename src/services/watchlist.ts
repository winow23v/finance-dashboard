import type { MarketSymbol } from '../types/marketSymbol'

// Favorites share the ticker namespace used by each market's provider.
export function favoriteKey({ market, symbol }: MarketSymbol) {
  return market + ':' + symbol.trim().toUpperCase()
}

export function isWatchlistSymbol(value: unknown): value is MarketSymbol {
  if (!value || typeof value !== 'object' || !('symbol' in value) || typeof value.symbol !== 'string'
    || !('market' in value) || !('exchange' in value)) return false
  return (value.market === 'KR' && value.exchange === 'XKRX' && /^[0-9A-Z]{6}$/.test(value.symbol))
    || (value.market === 'US' && ['US', 'XNAS', 'XNYS', 'ARCX'].some(exchange => exchange === value.exchange)
      && /^[A-Z][A-Z0-9]{0,9}(-[A-Z0-9]{1,5})?$/.test(value.symbol))
}
