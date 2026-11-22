import { marketSymbolKey, type MarketSymbol } from '../types/marketSymbol'

export const marketListings: readonly { listing: MarketSymbol; name: string; currency: 'KRW' | 'USD' }[] = [
  { listing: { market: 'KR', exchange: 'XKRX', symbol: '005930' }, currency: 'KRW', name: '삼성전자' },
  { listing: { market: 'KR', exchange: 'XKRX', symbol: '000660' }, currency: 'KRW', name: 'SK하이닉스' },
  { listing: { market: 'KR', exchange: 'XKRX', symbol: '035420' }, currency: 'KRW', name: 'NAVER' },
  { listing: { market: 'US', exchange: 'XNAS', symbol: 'AAPL' }, currency: 'USD', name: 'Apple' },
  { listing: { market: 'US', exchange: 'XNAS', symbol: 'MSFT' }, currency: 'USD', name: 'Microsoft' },
  { listing: { market: 'US', exchange: 'XNAS', symbol: 'NVDA' }, currency: 'USD', name: 'NVIDIA' },
  { listing: { market: 'US', exchange: 'XNAS', symbol: 'GOOGL' }, currency: 'USD', name: 'Alphabet Class A' },
  { listing: { market: 'US', exchange: 'XNAS', symbol: 'AMZN' }, currency: 'USD', name: 'Amazon' },
  { listing: { market: 'US', exchange: 'XNYS', symbol: 'DELL' }, currency: 'USD', name: 'Dell Technologies' },
  { listing: { market: 'US', exchange: 'XNYS', symbol: 'V' }, currency: 'USD', name: 'Visa' },
  { listing: { market: 'US', exchange: 'XNYS', symbol: 'BRK-B' }, currency: 'USD', name: 'Berkshire Hathaway Class B' },
  { listing: { market: 'US', exchange: 'ARCX', symbol: 'VOO' }, currency: 'USD', name: 'Vanguard S&P 500 ETF' },
  { listing: { market: 'US', exchange: 'ARCX', symbol: 'SCHD' }, currency: 'USD', name: 'Schwab U.S. Dividend Equity ETF' },
]

export function findMarketListing(listing: MarketSymbol) {
  const key = marketSymbolKey(listing)
  return marketListings.find(entry => marketSymbolKey(entry.listing) === key)
}

export function stockHref({ market, exchange, symbol }: MarketSymbol) {
  return '#stock/' + [market, exchange, symbol].map(encodeURIComponent).join('/')
}

export function parseStockPage(path: string): MarketSymbol | undefined {
  const [route, ...parts] = path.split('/')
  if (route !== 'stock' || parts.length !== 3) return
  try {
    const [market, exchange, symbol] = parts.map(decodeURIComponent)
    if ((market === 'KR' || market === 'US') && /^[A-Z0-9_-]{1,24}$/i.test(exchange) && /^[A-Z0-9._-]{1,32}$/i.test(symbol)) {
      return { market, exchange: exchange.toUpperCase(), symbol: symbol.toUpperCase() }
    }
  } catch {
    return undefined
  }
}
