import { useEffect, useState } from 'react'
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { financeService } from '../services/financeService'
import type { Period, SeriesPoint } from '../types/finance'

const periods: Period[] = ['1D', '1W', '1M', '3M', '1Y']
const number = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 2 })
const date = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric' })
const time = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })

export default function HistoryChart({ items, keyword = false, revision }: {
  items: { id: string; name: string }[]
  keyword?: boolean
  revision: number
}) {
  const [selection, setSelection] = useState('')
  const [comparison, setComparison] = useState('')
  const [period, setPeriod] = useState<Period>('1M')
  const [retry, setRetry] = useState(0)
  const id = items.find(item => item.id === selection)?.id ?? items[0]?.id
  const compareId = keyword && comparison !== id && items.some(item => item.id === comparison) ? comparison : ''
  const [result, setResult] = useState<{ key: string; points: ChartPoint[] | null }>()
  const key = JSON.stringify([id, compareId, period, keyword, revision, retry])

  useEffect(() => {
    if (!id) return
    let active = true
    const primary = keyword ? financeService.getKeywordTrend(id, period) : financeService.getPriceHistory(id, period)
    const secondary = compareId ? financeService.getKeywordTrend(compareId, period) : Promise.resolve([])
    Promise.all([primary, secondary]).then(
      ([points, comparisonPoints]) => { if (active) setResult({ key, points: alignSeries(points, comparisonPoints) }) },
      () => { if (active) setResult({ key, points: null }) },
    )
    return () => { active = false }
  }, [id, compareId, period, keyword, key])

  const points = result?.key === key ? result.points : undefined
  const tick = (value: string) => (period === '1D' ? time : date).format(new Date(value))
  const primaryName = items.find(item => item.id === id)?.name
  const comparisonName = items.find(item => item.id === compareId)?.name
  return <section className={keyword ? 'panel chart-panel trend-chart' : 'panel chart-panel'} aria-label={keyword ? '키워드 추이' : '지수 추이'}>
    <div className="panel-heading">
      <div>
        <h2>{keyword ? '검색 관심도 추이' : '지수 추이'}</h2>
        <p>{keyword ? '네이버 키워드 트렌드 · 상대 검색량 (0–100)' : '주요 시장 지수의 기간별 움직임'}</p>
      </div>
      {id && <div className="chart-selects">
        <select aria-label={keyword ? '기준 키워드' : '지수 선택'} value={id} onChange={event => {
          const next = event.target.value
          if (next === compareId) setComparison('')
          setSelection(next)
        }}>
          {items.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
        {keyword && <select aria-label="비교 키워드" value={compareId} onChange={event => setComparison(event.target.value)}>
          <option value="">비교 키워드 선택</option>
          {items.filter(item => item.id !== id).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>}
      </div>}
    </div>
    <div className="chart-toolbar">
      <div className="periods" role="group" aria-label="차트 기간">
        {periods.map(value => <button key={value} aria-pressed={value === period} onClick={() => setPeriod(value)}>{value}</button>)}
      </div>
      {compareId && points && <div className="chart-legend">
        <span>{primaryName}</span><span>{comparisonName}</span>
      </div>}
    </div>
    <div className="chart-body">
      {!id || points?.length === 0 ? <p className="state" role="status">표시할 데이터가 없습니다.</p>
        : points === undefined ? <p className="state" role="status">차트 데이터를 불러오는 중입니다.</p>
        : points === null ? <div className="state"><p role="alert">차트를 불러오지 못했습니다.</p><button className="button" onClick={() => setRetry(value => value + 1)}>다시 시도</button></div>
        : <ResponsiveContainer width="100%" height="100%" minWidth={0}>
          <AreaChart data={points} margin={{ top: 10, right: 12, left: 0, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--line)" strokeDasharray="4 5" />
            <XAxis dataKey="at" tickFormatter={tick} tick={{ fill: 'var(--muted)', fontSize: 12 }} minTickGap={30} axisLine={false} tickLine={false} tickMargin={10} />
            <YAxis orientation="right" width={63} tickFormatter={value => number.format(value)} domain={keyword ? [0, 100] : ['auto', 'auto']} tick={{ fill: 'var(--muted)', fontSize: 12 }} axisLine={false} tickLine={false} />
            <Tooltip labelFormatter={label => tick(String(label))} formatter={value => number.format(Number(value))} contentStyle={{ background: 'var(--panel)', borderColor: 'var(--line)', borderRadius: 8 }} />
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
