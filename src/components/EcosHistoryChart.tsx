import { useEffect, useRef } from 'react'
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'

export type EcosPoint = { period: string; value: number }

export default function EcosHistoryChart({ id, name, points, unit, collectedAt, onClose }: {
  id: string; name: string; points: EcosPoint[]; unit: string; collectedAt: string; onClose: () => void
}) {
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => { heading.current?.focus() }, [name])
  const daily = points[0].period.length === 10
  const format = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 2 })
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
          <YAxis width={48} domain={['auto', 'auto']} tickFormatter={value => format.format(value)} tick={{ fill: 'var(--muted)', fontSize: 11 }} />
          <Tooltip labelFormatter={value => dateLabel(Number(value))} formatter={value => format.format(Number(value)) + (unit.includes('%') ? '%' : '')}
            contentStyle={{ background: 'var(--panel)', borderColor: 'var(--line)' }} />
          <Line name={name} dataKey="value" stroke="var(--accent)" strokeWidth={2} dot={points.length <= 24} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
    <details className="chart-note">
      <summary>관측값 표</summary>
      <div className="disclosure-table"><table>
        <thead><tr><th scope="col">{daily ? '관측일' : '관측월'}</th><th scope="col">값 ({unit})</th></tr></thead>
        <tbody>{points.map(point => <tr key={point.period}><th scope="row"><time dateTime={point.period}>{point.period}</time></th><td>{format.format(point.value)}</td></tr>)}</tbody>
      </table></div>
    </details>
    <p className="chart-note">출처 한국은행 ECOS · 수집 시각 (KST) <time dateTime={collectedAt}>{new Intl.DateTimeFormat('ko-KR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Seoul' }).format(new Date(collectedAt))}</time></p>
  </section>
}
