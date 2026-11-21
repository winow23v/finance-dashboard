import type { Period, SeriesPoint } from '../types/finance'
import { financeService } from './financeService'
import { createRequestCache } from './requestCache'

export const historyPeriods: Period[] = ['1D', '1W', '1M', '3M', '1Y']
export const defaultHistoryPeriod = '1M'
const cache = createRequestCache<SeriesPoint[]>(40, 5 * 60_000)

export function marketHistory(id: string, period: Period, keyword: boolean, revision: number) {
  const key = JSON.stringify([id, period, keyword, revision])
  return {
    read: () => cache.read(key),
    load: () => cache.load(key, () => keyword
      ? financeService.getKeywordTrend(id, period)
      : financeService.getPriceHistory(id, period)),
  }
}
