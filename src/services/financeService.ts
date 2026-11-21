import { apiFinanceService } from './apiFinanceService'
import { mockFinanceService } from '../mocks/mockFinance'
import type { FinanceSnapshot, Period, SeriesPoint } from '../types/finance'

export interface FinanceService {
  getSnapshot(): Promise<FinanceSnapshot>
  getPriceHistory(symbolId: string, period: Period): Promise<SeriesPoint[]>
  getKeywordTrend(keyword: string, period: Period): Promise<SeriesPoint[]>
}

export const dataMode = import.meta.env.VITE_DATA_MODE === 'api' ? 'api' : 'mock'
export const financeService: Pick<FinanceService, 'getPriceHistory' | 'getKeywordTrend'> = dataMode === 'api' ? apiFinanceService : mockFinanceService
