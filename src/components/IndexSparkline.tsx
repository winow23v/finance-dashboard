import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { SeriesPoint } from '../types/finance'

const date = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric' })
const number = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 2 })

export default function IndexSparkline({ name, points, onOpen }: {
  name: string; points: SeriesPoint[]; onOpen: () => void
}) {
  return <div className="index-sparkline">
    <div className="sparkline-plot" aria-label={`${name} 최근 1개월 추이`}>
      <ResponsiveContainer width="100%" height="100%" minWidth={0}>
        <LineChart data={points} onClick={onOpen} margin={{ top: 5, right: 4, bottom: 5, left: 4 }}>
          <XAxis dataKey="at" hide />
          <YAxis hide domain={['dataMin', 'dataMax']} />
          <Tooltip labelFormatter={value => date.format(new Date(String(value)))}
            formatter={value => number.format(Number(value))} contentStyle={{ background: 'var(--panel)', borderColor: 'var(--line)' }} />
          <Line name={name} dataKey="value" stroke="var(--accent)" dot={false} strokeWidth={2} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
    <button type="button" className="button" onClick={onOpen} aria-controls="market-history" aria-label={`${name} 상세 차트`}>상세 차트</button>
  </div>
}
