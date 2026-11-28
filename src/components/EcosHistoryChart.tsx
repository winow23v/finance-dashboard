import { FinancialTooltip } from './FinancialTooltip'
import { financialAxis, financialNumber } from '../services/financialNumbers'
import { useEffect, useRef } from 'react'
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'

export type EcosPoint = { period: string; value: number }

export default function EcosHistoryChart({ id, name, points, unit, onClose }: {
  id: string; name: string; points: EcosPoint[]; unit: string; onClose: () => void
}) {
  const heading = useRef<HTMLHeadingElement>(null)
  const tooltipTrigger = matchMedia('(hover: none)').matches ? 'click' : 'hover'
  useEffect(() => { heading.current?.focus() }, [name])
  const daily = points[0].period.length === 10
  const data = points.map(point => ({ ...point, at: Date.parse(daily ? point.period : point.period + '-01') }))
  const dateLabel = (value: number) => Number.isFinite(value) ? new Date(value).toISOString().slice(0, daily ? 10 : 7) : ''
  return <section id={id} className="panel chart-panel" aria-labelledby={id + '-title'}>
    <div className="panel-heading">
      <div><h2 id={id + '-title'} ref={heading} tabIndex={-1}>{name} 추이</h2>
        <p>{daily ? '일별 관측' : '월별 관측'} · {points[0].period} ~ {points.at(-1)?.period} · {unit}</p></div>
      <button type="button" className="button" onClick={onClose}>차트 닫기</button>
    </div>
    <div className="chart-body">
      <ResponsiveContainer width="100%" height="100%" minWidth={0}>
        <LineChart data={data} accessibilityLayer margin={{ top: 14, right: 12, bottom: 8 }}>
          <CartesianGrid vertical={false} stroke="var(--line)" strokeDasharray="4 5" />
          <XAxis dataKey="at" type="number" scale="time" domain={['dataMin', 'dataMax']} tickFormatter={dateLabel}
            minTickGap={24} tick={{ fill: 'var(--muted)', fontSize: 11 }} />
          <YAxis width={48} domain={['auto', 'auto']} tickFormatter={value => financialAxis(value)} tick={{ fill: 'var(--muted)', fontSize: 11 }} />
          <Tooltip trigger={tooltipTrigger} isAnimationActive={false} wrapperClassName="terminal-chart-tooltip" allowEscapeViewBox={{ x: false, y: false }}
            content={props => <FinancialTooltip {...props} formatDate={value => dateLabel(Number(value))}
              formatValue={value => typeof value === 'number' ? financialNumber(value) + (unit.includes('%') ? '%' : '') : '자료 부족'} />} />
          <Line name={name} dataKey="value" stroke="var(--accent)" strokeWidth={2} dot={points.length <= 24} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
    <details className="chart-note chart-data">
      <summary>관측값 표</summary>
      <div className="chart-data-scroll" role="region" aria-label={name + ' 관측값 표'} tabIndex={0}><table>
        <caption className="sr-only">{name} 관측값 및 단위</caption>
        <thead><tr><th scope="col">{daily ? '관측일' : '관측월'}</th><th scope="col">값 ({unit})</th></tr></thead>
        <tbody>{points.map(point => <tr key={point.period}><th scope="row"><time dateTime={point.period}>{point.period}</time></th><td>{financialNumber(point.value)}</td></tr>)}</tbody>
      </table></div>
    </details>
  </section>
}
