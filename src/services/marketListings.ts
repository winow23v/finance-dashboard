import { marketSymbolKey, type MarketSymbol } from '../types/marketSymbol'

export const marketListings: readonly { listing: MarketSymbol; name: string }[] = [
  { listing: { market: 'KR', exchange: 'XKRX', symbol: '005930' }, name: '삼성전자' },
  { listing: { market: 'KR', exchange: 'XKRX', symbol: '000660' }, name: 'SK하이닉스' },
  { listing: { market: 'KR', exchange: 'XKRX', symbol: '035420' }, name: 'NAVER' },
  { listing: { market: 'US', exchange: 'XNAS', symbol: 'AAPL' }, name: 'Apple' },
  { listing: { market: 'US', exchange: 'XNAS', symbol: 'MSFT' }, name: 'Microsoft' },
  { listing: { market: 'US', exchange: 'XNAS', symbol: 'NVDA' }, name: 'NVIDIA' },
  { listing: { market: 'US', exchange: 'XNAS', symbol: 'GOOGL' }, name: 'Alphabet Class A' },
  { listing: { market: 'US', exchange: 'ARCX', symbol: 'VOO' }, name: 'Vanguard S&P 500 ETF' },
]

export function findMarketListing(listing: MarketSymbol) {
  const key = marketSymbolKey(listing)
  return marketListings.find(entry => marketSymbolKey(entry.listing) === key)
}
