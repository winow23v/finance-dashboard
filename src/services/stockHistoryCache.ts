import { getKrxAnalysis, getUsAnalysis } from './apiFinanceService'
import { memberDataEpoch } from './memberTransport'
import { createRequestCache } from './requestCache'

const krx = createRequestCache<Awaited<ReturnType<typeof getKrxAnalysis>>>(20, 60_000)
const us = createRequestCache<Awaited<ReturnType<typeof getUsAnalysis>>>(20, 60_000)

// The API enforces its own timeout. A shared read can finish after one view
// leaves, while each view still ignores results after its own cleanup.
export function readKrxStockHistory(symbol: string) {
  return krx.load(JSON.stringify([memberDataEpoch(), symbol]),
    () => getKrxAnalysis(symbol, AbortSignal.timeout(15_000)),
    data => !!data.quote && !data.reason && data.history.completeness === 'complete'
      && data.latestDate === data.quote.tradingDate && data.history.bars.at(-1)?.tradingDate === data.latestDate)
}

export function readUsStockHistory(symbol: string) {
  return us.load(JSON.stringify([memberDataEpoch(), symbol]),
    () => getUsAnalysis(symbol, AbortSignal.timeout(15_000)),
    data => data.status === 'available' && !data.reason
      && data.history.bars.at(-1)?.tradingDate === data.quote.tradingDate)
}

export function invalidateStockHistory(market: 'KR' | 'US', symbol: string) {
  const cache = market === 'KR' ? krx : us
  cache.invalidate(JSON.stringify([memberDataEpoch(), symbol]))
}
