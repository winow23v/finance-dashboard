import { marketSymbolKey, type MarketSymbol } from '../types/marketSymbol'

export type TradingViewSymbol = { symbol: string; embeddable: boolean }

// Symbol Overview confirmed the exact indices exist but restricts external embedding.
export const tradingViewIndices: Readonly<Record<string, TradingViewSymbol | undefined>> = {
  kospi: { symbol: 'KRX:KOSPI', embeddable: false },
  kosdaq: { symbol: 'KRX:KOSDAQ', embeddable: false },
  spx: { symbol: 'SP:SPX', embeddable: false },
  nasdaq: { symbol: 'NASDAQ:IXIC', embeddable: false },
}

export const tradingViewListings: readonly { listing: MarketSymbol; name: string; chart: TradingViewSymbol }[] = [
  { listing: { market: 'KR', exchange: 'XKRX', symbol: '005930' }, name: '삼성전자', chart: { symbol: 'KRX:005930', embeddable: false } },
  { listing: { market: 'KR', exchange: 'XKRX', symbol: '000660' }, name: 'SK하이닉스', chart: { symbol: 'KRX:000660', embeddable: false } },
  { listing: { market: 'KR', exchange: 'XKRX', symbol: '035420' }, name: 'NAVER', chart: { symbol: 'KRX:035420', embeddable: false } },
  { listing: { market: 'US', exchange: 'XNAS', symbol: 'AAPL' }, name: 'Apple', chart: { symbol: 'NASDAQ:AAPL', embeddable: true } },
  { listing: { market: 'US', exchange: 'XNAS', symbol: 'MSFT' }, name: 'Microsoft', chart: { symbol: 'NASDAQ:MSFT', embeddable: true } },
  { listing: { market: 'US', exchange: 'XNAS', symbol: 'NVDA' }, name: 'NVIDIA', chart: { symbol: 'NASDAQ:NVDA', embeddable: true } },
  { listing: { market: 'US', exchange: 'XNAS', symbol: 'GOOGL' }, name: 'Alphabet Class A', chart: { symbol: 'NASDAQ:GOOGL', embeddable: true } },
  { listing: { market: 'US', exchange: 'ARCX', symbol: 'VOO' }, name: 'Vanguard S&P 500 ETF', chart: { symbol: 'AMEX:VOO', embeddable: true } },
]

export function findTradingViewListing(listing: MarketSymbol) {
  const key = marketSymbolKey(listing)
  return tradingViewListings.find(entry => marketSymbolKey(entry.listing) === key)
}
