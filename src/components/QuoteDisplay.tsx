import { ArrowDownRight, ArrowUpRight } from 'lucide-react'
import type { Quote } from '../types/finance'
import type { SettingsState } from '../storage/guestStorage'

const numeral = new Intl.NumberFormat('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const integer = new Intl.NumberFormat('ko-KR')
const compact = new Intl.NumberFormat('ko-KR', { notation: 'compact', maximumFractionDigits: 2 })
const signed = (value: number) => (value > 0 ? '+' : '') + numeral.format(value)
export const marketNames = { KR: '국내', US: '미국', FX: '외환' }

export function price(quote: Quote, units: SettingsState['units']) {
  const equity = quote.kind === 'stock' || quote.kind === 'etf'
  if (equity && units === 'compact' && Math.abs(quote.price) >= 10000) return compact.format(quote.price)
  return (equity && quote.currency === 'KRW' ? integer : numeral).format(quote.price)
}

export function Change({ quote, detailed = false }: { quote: Quote; detailed?: boolean }) {
  const Icon = quote.percent < 0 ? ArrowDownRight : ArrowUpRight
  return <span className={'change ' + (quote.percent > 0 ? 'up' : quote.percent < 0 ? 'down' : '')}>
    {quote.percent !== 0 && <Icon size={15} aria-hidden="true" />}
    {detailed ? signed(quote.change) + ' (' + signed(quote.percent) + '%)' : signed(quote.percent) + '%'}
  </span>
}
