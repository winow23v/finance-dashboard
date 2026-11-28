import type { TooltipContentProps } from 'recharts'

export function FinancialTooltip({ active, payload, label, formatValue, formatDate = String }: TooltipContentProps & {
  formatValue: (value: unknown) => string
  formatDate?: (label: string | number) => string
}) {
  if (!active || !payload?.length) return null
  return <div className="financial-tooltip">
    {label != null && <div className="financial-tooltip-date">{formatDate(label)}</div>}
    <dl>{payload.map((entry, index) => <div key={String(entry.dataKey ?? index)}>
      <dt><span aria-hidden="true" style={{ backgroundColor: entry.color ?? 'var(--muted)' }} />{entry.name}</dt>
      <dd>{formatValue(entry.value)}</dd>
    </div>)}</dl>
  </div>
}
