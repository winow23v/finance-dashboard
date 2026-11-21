export const marketIndices = [
  { id: 'kospi', symbol: 'KOSPI', name: 'KOSPI', market: 'KR' },
  { id: 'kosdaq', symbol: 'KOSDAQ', name: 'KOSDAQ', market: 'KR' },
  { id: 'spx', symbol: '^GSPC', name: 'S&P 500', market: 'US' },
  { id: 'nasdaq', symbol: '^IXIC', name: 'NASDAQ Composite', market: 'US' },
]

function unavailable(index, reason) {
  return { ...index, status: 'unavailable', reason, price: null, change: null,
    changePercent: null, observedAt: null, tradingDate: null, collectedAt: null, source: null }
}

export function createIndexSnapshot(research, krx) {
  return async function snapshot() {
    const quotes = await Promise.all(marketIndices.map(async index => {
      if (index.market === 'KR') {
        if (!krx) return unavailable(index, 'provider-not-configured')
        const quote = await krx.indices(index.symbol)
        return quote.price ? { ...index, ...quote } : { ...unavailable(index, quote.reason), errorCode: quote.errorCode }
      }
      if (!research) return unavailable(index, 'provider-not-configured')
      let quote
      try {
        quote = await research.getQuote(index.symbol)
      } catch {
        return unavailable(index, 'provider-error')
      }
      if (!quote || !['available', 'stale'].includes(quote.dataStatus)) {
        return unavailable(index, quote?.dataStatus === 'no-observation' ? 'no-observation' : 'provider-error')
      }
      const { close, previousClose, observedAt, tradingDate, collectedAt } = quote
      const change = close - previousClose
      const changePercent = change / previousClose * 100
      const observationTime = Date.parse(observedAt)
      const collectionTime = Date.parse(collectedAt)
      if (quote.symbol !== index.symbol || quote.distribution !== 'local-research-only' ||
        !Number.isFinite(close) || close <= 0 || !Number.isFinite(previousClose) || previousClose <= 0 ||
        !Number.isFinite(changePercent) || !Number.isFinite(observationTime) ||
        !Number.isFinite(collectionTime) || collectionTime < observationTime ||
        !/^\d{4}-\d{2}-\d{2}$/.test(tradingDate)) {
        return unavailable(index, 'provider-error')
      }
      return { ...index, status: quote.dataStatus, price: close, change, changePercent,
        observedAt, tradingDate, collectedAt, source: 'Yahoo Finance via yfinance' }
    }))
    const latest = (field) => quotes.reduce((time, quote) =>
      quote[field] && (time === null || Date.parse(quote[field]) > Date.parse(time)) ? quote[field] : time, null)
    const updatedAt = latest('collectedAt')
    return { asOf: latest('observedAt'), data: {
      source: { label: research || krx ? 'Local market research' : 'Market indices', simulated: false },
      updatedAt, quotes,
    } }
  }
}
