import { FinancialTooltip } from './FinancialTooltip'
import { financialAxis, financialNumber } from '../services/financialNumbers'
import { LoadingSkeleton } from "./LoadingSkeleton"
import { useEffect, useState } from 'react'
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { defaultHistoryPeriod, historyPeriods, marketHistory } from '../services/marketHistory'
import type { Period, SeriesPoint } from '../types/finance'

const date = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric' })
const time = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
export default function HistoryChart({ items, simulated, revision }: {
  items: { id: string; name: string }[]; simulated: boolean; revision: number
}) {
  const [selection, setSelection] = useState('')
  const [comparison, setComparison] = useState('')
  const [period, setPeriod] = useState<Period>(defaultHistoryPeriod)
  const [retry, setRetry] = useState(0)
  const id = items.find(item => item.id === selection)?.id ?? items[0]?.id
  const compareId = comparison !== id && items.some(item => item.id === comparison) ? comparison : ''
  const [result, setResult] = useState<{ key: string; points: ChartPoint[] | null }>()
  const key = JSON.stringify([id, compareId, period, revision, retry])

  useEffect(() => {
    if (!id) return
    let active = true
    const primary = marketHistory(id, period, true, revision).load()
    const secondary = compareId ? marketHistory(compareId, period, true, revision).load() : Promise.resolve([])
    Promise.all([primary, secondary]).then(
      ([points, comparisonPoints]) => { if (active) setResult({ key, points: alignSeries(points, comparisonPoints) }) },
      () => { if (active) setResult({ key, points: null }) },
    )
    return () => { active = false }
  }, [id, compareId, period, revision, key])

  const primaryCached = id ? marketHistory(id, period, true, revision).read() : undefined
  const comparisonCached = compareId ? marketHistory(compareId, period, true, revision).read() : []
  const points = result?.key === key ? result.points
    : primaryCached && comparisonCached ? alignSeries(primaryCached, comparisonCached) : undefined
  const tick = (value: string) => (period === '1D' ? time : date).format(new Date(value))
  const primaryName = items.find(item => item.id === id)?.name
  const comparisonName = items.find(item => item.id === compareId)?.name
  return <section className="panel chart-panel trend-chart" aria-label="키워드 추이">
    <div className="panel-heading">
      <div>
        <h2>검색 관심도 추이{simulated && ' · DEMO'}</h2>
        <p>키워드 상대 검색량 (0–100)</p>
      </div>
      {id && <div className="chart-selects">
        <select aria-label="기준 키워드" value={id} onChange={event => {
          const next = event.target.value
          if (next === compareId) setComparison('')
          setSelection(next)
        }}>
          {items.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
        <select aria-label="비교 키워드" value={compareId} onChange={event => setComparison(event.target.value)}>
          <option value="">비교 키워드 선택</option>
          {items.filter(item => item.id !== id).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
      </div>}

    </div>
    <div className="chart-toolbar">
      <div className="periods" role="group" aria-label="차트 기간">
        {historyPeriods.map(value => <button key={value} aria-pressed={value === period} onClick={() => setPeriod(value)}>
          {value}</button>)}
      </div>
      {compareId && points && <div className="chart-legend">
        <span>{primaryName}</span><span>{comparisonName}</span>
      </div>}
    </div>
    <div className="chart-body">
      {!id || points?.length === 0 ? <p className="state" role="status">표시할 데이터가 없습니다.</p>
        : points === undefined ? <LoadingSkeleton message="차트 데이터를 불러오는 중입니다." shape="chart" contained />
        : points === null ? <div className="state"><p role="alert">차트를 불러오지 못했습니다.</p><button className="button" onClick={() => setRetry(value => value + 1)}>다시 시도</button></div>
        : <ResponsiveContainer width="100%" height="100%" minWidth={0}>
          <AreaChart data={points} margin={{ top: 10, right: 12, left: 0, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--line)" strokeDasharray="4 5" />
            <XAxis dataKey="at" tickFormatter={tick} tick={{ fill: 'var(--muted)', fontSize: 12 }} minTickGap={30} axisLine={false} tickLine={false} tickMargin={10} />
            <YAxis orientation="right" width={63} tickFormatter={value => financialAxis(value)} domain={[0, 100]} tick={{ fill: 'var(--muted)', fontSize: 12 }} axisLine={false} tickLine={false} />
            <Tooltip isAnimationActive={false} wrapperClassName="terminal-chart-tooltip" allowEscapeViewBox={{ x: false, y: false }}
              content={props => <FinancialTooltip {...props} formatValue={value => financialNumber(typeof value === 'number' ? value : null)} />} />
            <Area name={primaryName} dataKey="value" stroke="var(--accent)" fill="var(--accent)" fillOpacity={0.09} strokeWidth={2} isAnimationActive={false} />
            {compareId && <Area name={comparisonName} dataKey="comparison" stroke="var(--blue)" fill="none" strokeDasharray="5 4" strokeWidth={2} isAnimationActive={false} />}
          </AreaChart>
        </ResponsiveContainer>}
    </div>
    {compareId && points?.length && (!points.some(point => point.comparison !== undefined) || !points.some(point => point.value !== undefined))
      ? <p className="chart-note" role="status">선택한 키워드 중 일부의 데이터가 없습니다.</p> : null}
  </section>
}

type ChartPoint = { at: string; value?: number; comparison?: number }

function alignSeries(primary: SeriesPoint[], comparison: SeriesPoint[]): ChartPoint[] {
  if (!comparison.length) return primary
  const rows = new Map<number, ChartPoint>()
  for (const { at, value } of primary) rows.set(Date.parse(at), { at, value })
  for (const { at, value } of comparison) {
    const timestamp = Date.parse(at)
    rows.set(timestamp, { ...(rows.get(timestamp) ?? { at }), comparison: value })
  }
  return [...rows].sort(([left], [right]) => left - right).map(([, point]) => point)
}
