import { TrendingDown, TrendingUp } from 'lucide-react'
import type { Quote } from '../types/finance'
import { financialNumber, financialPercent } from '../services/financialNumbers'

export const marketNames = { KR: '국내', US: '미국', FX: '외환' }

export function Change({ quote, market, detailed = false }: { market?: 'KR' | 'US'; quote: Pick<Quote, 'percent' | 'change'>; detailed?: boolean }) {
  const Icon = quote.percent < 0 ? TrendingDown : TrendingUp
  return <span data-market={market} className={'change ' + (quote.percent > 0 ? 'up' : quote.percent < 0 ? 'down' : 'flat')}>
    {quote.percent !== 0 && <Icon size={15} strokeWidth={1.75} aria-hidden="true" />}
    {detailed ? financialNumber(quote.change, 2, true) + ' (' + financialPercent(quote.percent, true) + ')' : financialPercent(quote.percent, true)}
  </span>
}
