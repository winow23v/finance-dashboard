import type { FinanceService } from '../services/financeService'
import type { EquityMarket } from '../types/marketSymbol'
import type { FinanceSnapshot, Period, Quote, SeriesPoint } from '../types/finance'

const asOf = '2026-11-18T21:00:00Z'
const rows: [string, string, string, Quote['market'], Quote['kind'], number, number, number, string?][] = [
  ['kospi', 'KOSPI', 'KRX:KOSPI', 'KR', 'index', 2658.41, 21.63, 0.82],
  ['kosdaq', 'KOSDAQ', 'KRX:KOSDAQ', 'KR', 'index', 784.22, -3.62, -0.46],
  ['spx', 'S&P 500', 'SPX', 'US', 'index', 5870.62, 35.02, 0.60],
  ['nasdaq', 'NASDAQ', 'IXIC', 'US', 'index', 18972.42, 214.04, 1.14],
  ['usdkrw', 'USD/KRW', 'USD/KRW', 'FX', 'fx', 1382.50, -4.50, -0.32],
  ['005930', '삼성전자', '005930', 'KR', 'stock', 58400, 700, 1.21],
  ['000660', 'SK하이닉스', '000660', 'KR', 'stock', 187500, 2900, 1.57],
  ['AAPL', '애플', 'AAPL', 'US', 'stock', 228.68, -0.78, -0.34],
  ['NVDA', '엔비디아', 'NVDA', 'US', 'stock', 145.89, 3.34, 2.34],
  ['MSFT', '마이크로소프트', 'MSFT', 'US', 'stock', 425.71, 4.26, 1.01],
  ['069500', 'KODEX 200', '069500', 'KR', 'etf', 35175, 215, 0.62],
  ['SPY', 'SPDR S&P 500 ETF Trust', 'SPY', 'US', 'etf', 586.90, 3.48, 0.60, 'ARCX'],
  ['035420', 'NAVER', '035420', 'KR', 'stock', 208000, -1000, -0.48],
]
const quotes: Quote[] = rows.map(([id, name, symbol, market, kind, price, change, percent, venue]) => {
  const fields = {
    id, name, symbol, price, change, percent, asOf, delayed: false,
    currency: market === 'US' ? 'USD' as const : 'KRW' as const,
  }
  if (kind === 'stock' || kind === 'etf') {
    const listingMarket: EquityMarket = market === 'KR' ? 'KR' : 'US'
    return { ...fields, kind, market: listingMarket, exchange: venue ?? (listingMarket === 'KR' ? 'XKRX' : 'XNAS') }
  }
  return { ...fields, kind, market }
})
const snapshot: FinanceSnapshot = {
  source: { label: 'DEMO', simulated: true },
  updatedAt: asOf,
  quotes,
  marketStatus: { KR: 'closed', US: 'closed' },
  trendTopics: ['반도체', '미국 금리', '환율'],
  indicators: [
    { id: 'fed', name: '미국 기준금리', value: 4.50, observationDate: '2026-11-05', releaseDate: '2026-11-05' },
    { id: 'treasury', name: '미국 10년물 국채금리', value: 4.28, observationDate: '2026-11-18', releaseDate: '2026-11-18' },
    { id: 'cpi', name: '미국 소비자물가지수 (CPI)', value: 2.60, observationDate: '2026-10-31', releaseDate: '2026-11-12' },
    { id: 'unemployment', name: '미국 실업률', value: 4.10, observationDate: '2026-10-31', releaseDate: '2026-11-06' },
  ].map(row => ({ ...row, unit: '%', collectedAt: asOf })),
}

const days: Record<Period, number> = { '1D': 0.27, '1W': 7, '1M': 30, '3M': 90, '1Y': 365 }
const shape = [0, .08, .04, .19, .11, .16, .17, .29, .24, .38, .32, .42, .36, .49, .45, .58, .52, .55, .78, .71, .83, .76, .88, .84, 1]
function series(key: string, period: Period, last: number, end = asOf): SeriesPoint[] {
  const seed = Array.from(key + period).reduce((sum, char) => sum + char.charCodeAt(0), 0)
  const range = last * (0.018 + days[period] / 2600)
  return shape.map((level, index) => {
    const position = index / (shape.length - 1)
    const wobble = Math.sin(index * 1.7 + seed) * .07 * (1 - position)
    return {
      at: new Date(Date.parse(end) - (1 - position) * days[period] * 86400000).toISOString(),
      value: Math.round((last + range * (level - 1 + wobble)) * 100) / 100,
    }
  })
}

export const mockFinanceService: FinanceService = {
  async getSnapshot() {
    await new Promise(resolve => setTimeout(resolve, 260))
    return structuredClone(snapshot)
  },
  async getPriceHistory(id, period) {
    const quote = snapshot.quotes.find(item => item.id === id)
    return quote ? series(id, period, quote.price, quote.asOf) : []
  },
  async getKeywordTrend(keyword, period) {
    const topic = snapshot.trendTopics.indexOf(keyword)
    return topic < 0 ? [] : series(keyword, period, 86 - topic * 9)
  },
}
