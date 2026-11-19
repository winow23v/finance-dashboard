import { mockFinanceService } from '../mocks/mockFinance'
import type { FinanceSnapshot, Period, SeriesPoint } from '../types/finance'

export interface FinanceService {
  getSnapshot(): Promise<FinanceSnapshot>
  getPriceHistory(symbolId: string, period: Period): Promise<SeriesPoint[]>
  getKeywordTrend(keyword: string, period: Period): Promise<SeriesPoint[]>
}

export const financeService: FinanceService = mockFinanceService
