export type EquityMarket = 'KR' | 'US'

export interface MarketSymbol {
  market: EquityMarket
  exchange: string
  symbol: string
}

export function marketSymbolKey({ market, exchange, symbol }: MarketSymbol): string {
  return JSON.stringify([market, exchange.trim().toUpperCase(), symbol.trim().toUpperCase()])
}
