import { Globe2, Landmark } from 'lucide-react'
import type { ReactNode } from 'react'
import { marketNames } from './QuoteDisplay'

export function CompactMarketQuote({ market, title, children, action, footer }: {
  market: keyof typeof marketNames
  title: ReactNode
  children: ReactNode
  action?: ReactNode
  footer?: ReactNode
}) {
  const Icon = market === 'FX' ? Globe2 : Landmark
  return <article className="panel quote-card compact-market-quote">
    <header className="compact-quote-heading">
      <Icon size={15} aria-hidden="true" />
      <span className="sr-only">{marketNames[market]} </span>
      <h3>{title}</h3>
      {action}
    </header>
    <div className="compact-quote-data">{children}</div>
    {footer}
  </article>
}
