import { ChartNoAxesCombined } from 'lucide-react'
import { useId, useMemo, useState } from 'react'
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { formatAnalysisPrice, formatVolume } from '../services/analysisPrices'
import { simpleMovingAverage } from '../services/technicalIndicators'
import type { MarketDailyHistory } from '../types/marketDataProvider'

const periods = [20, 60, 120] as const
const averages = [
  { days: 20, key: 'sma20', name: 'SMA 20', color: 'var(--blue)', dash: '6 3' },
  { days: 50, key: 'sma50', name: 'SMA 50', color: 'var(--favorite)', dash: '2 3' },
] as const
const axisNumber = new Intl.NumberFormat('ko-KR', { notation: 'compact', maximumFractionDigits: 1 })
const axisTick = { fill: 'var(--muted)', fontSize: 11 }
const tooltip = { background: 'var(--panel)', color: 'var(--text)', borderColor: 'var(--line)', borderRadius: 8 }
const grid = { stroke: 'var(--line)', strokeDasharray: '4 5', vertical: false }
const margin = { top: 6, right: 10, left: 4, bottom: 0 }

export default function StockHistoryChart({ history, source }: { history: MarketDailyHistory; source: string }) {
  const [period, setPeriod] = useState<(typeof periods)[number]>(60)
  const id = useId()
  const tooltipTrigger = matchMedia('(hover: none)').matches ? 'click' : 'hover'
  const { bars, currency } = history
  const basis = history.adjustment === 'total-return-adjusted' ? '배당·분할 조정 종가'
    : history.adjustment === 'split-adjusted' ? '분할 조정 종가' : '미수정 종가'
  const points = useMemo(() => {
    const closes = bars.map(bar => bar.close)
    const start = Math.max(0, bars.length - period)
    return bars.slice(start).map((bar, offset) => {
      const end = start + offset + 1
      const average = (days: number) => simpleMovingAverage(closes.slice(Math.max(0, end - days), end), days)
      return { tradingDate: bar.tradingDate, close: bar.close, volume: bar.volume, sma20: average(20), sma50: average(50) }
    })
  }, [bars, period])
  const hasVolume = points.some(point => point.volume > 0)
  const visibleAverages = averages.filter(({ key }) => points.some(point => point[key] !== null))
  const dateAxis = <XAxis dataKey="tradingDate" tickFormatter={value => String(value).slice(5)} minTickGap={24}
    interval="preserveStartEnd" tick={axisTick} tickMargin={7} tickLine={false} axisLine={false} />
  const axis = { orientation: 'right' as const, width: 52, tickFormatter: (value: number) => axisNumber.format(value),
    tick: axisTick, tickLine: false, axisLine: false }

  return <section className="stock-history" aria-labelledby={id}>
    <div className="analysis-heading">
      <div><h2 id={id}><ChartNoAxesCombined size={17} aria-hidden="true" /> 가격 추이</h2>
        <small>{source} · {basis} · {currency}</small></div>
      {bars.length > 0 && <div className="periods" role="group" aria-label="차트 기간">
        {periods.map(days => <button type="button" key={days} aria-pressed={period === days}
          onClick={() => setPeriod(days)}>{days}일</button>)}
      </div>}
    </div>
    <p className="stock-history-range">{bars.length ? <>
      확보한 일봉 {bars.length}개 중 {points.length}거래일 · <time dateTime={points[0].tradingDate}>{points[0].tradingDate}</time>
      {' ~ '}<time dateTime={points.at(-1)?.tradingDate}>{points.at(-1)?.tradingDate}</time>
    </> : '표시할 일봉 데이터가 없습니다.'}</p>
    {points.length > 0 && history.completeness === 'missing-observations' && <p className="stock-history-range">
      수집된 일봉만 표시합니다. 일부 거래일의 관측값이 없습니다.
    </p>}
    {points.length === 1 && <p className="state" role="status">일봉이 1개뿐이어서 가격 추이를 비교할 수 없습니다.</p>}
    {points.length > 0 && <>
      <div className="stock-chart-legend" aria-label="가격 차트 범례">
        <span><i aria-hidden="true" />{basis}</span>
        {averages.map(({ key, name, days }) => <span key={key} data-line={key}>
          <i aria-hidden="true" />{name}{bars.length < days && ' · 자료 부족'}
        </span>)}
      </div>
      <div className="stock-price-plot">
        <ResponsiveContainer width="100%" height="100%" minWidth={0}>
          <LineChart data={points} margin={margin} title={basis + ' 차트'} accessibilityLayer syncId={id}>
            <CartesianGrid {...grid} />
            {dateAxis}
            <YAxis {...axis} domain={['auto', 'auto']} />
            <Tooltip trigger={tooltipTrigger} isAnimationActive={false} wrapperClassName="terminal-chart-tooltip" allowEscapeViewBox={{ x: false, y: false }} contentStyle={tooltip} itemStyle={{ color: 'var(--text)' }}
              formatter={value => typeof value === 'number' ? formatAnalysisPrice(value, currency) : '자료 부족'} />
            <Line dataKey="close" name={basis} stroke="var(--accent)" strokeWidth={2} dot={points.length === 1}
              isAnimationActive={false} />
            {visibleAverages.map(({ key, name, color, dash }) => <Line key={key} dataKey={key} name={name} stroke={color}
              strokeWidth={2} strokeDasharray={dash} dot={false} isAnimationActive={false} />)}
          </LineChart>
        </ResponsiveContainer>
      </div>
      <h3 className="stock-volume-heading">거래량 <small>단위 · 주</small></h3>
      {hasVolume ? <div className="stock-volume-plot">
        <ResponsiveContainer width="100%" height="100%" minWidth={0}>
          <BarChart data={points} margin={margin} title="거래량 차트" accessibilityLayer syncId={id}>
            <CartesianGrid {...grid} />
            {dateAxis}
            <YAxis {...axis} />
            <Tooltip trigger={tooltipTrigger} isAnimationActive={false} wrapperClassName="terminal-chart-tooltip" allowEscapeViewBox={{ x: false, y: false }} contentStyle={tooltip} itemStyle={{ color: 'var(--text)' }}
              formatter={value => typeof value === 'number' ? formatVolume(value) : '자료 부족'} />
            <Bar dataKey="volume" name="거래량" fill="var(--blue)" isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </div> : <p className="stock-history-range" data-state="insufficient">표시 구간에 양수 거래량이 없습니다.</p>}
      <details className="chart-data">
        <summary>종가·거래량 데이터 표</summary>
        <div className="chart-data-scroll" tabIndex={0} role="region" aria-label="종가·거래량 데이터 표">
          <table>
            <caption className="sr-only">{basis} ({currency}), 이동평균, 거래량 (주) · {points.length}거래일</caption>
            <thead><tr><th scope="col">거래일</th><th scope="col">종가 ({currency})</th>
              <th scope="col">SMA 20</th><th scope="col">SMA 50</th><th scope="col">거래량 (주)</th></tr></thead>
            <tbody>{points.slice().reverse().map(point => <tr key={point.tradingDate}>
              <th scope="row"><time dateTime={point.tradingDate}>{point.tradingDate}</time></th>
              <td>{formatAnalysisPrice(point.close, currency)}</td>
              <td>{point.sma20 === null ? '자료 부족' : formatAnalysisPrice(point.sma20, currency)}</td>
              <td>{point.sma50 === null ? '자료 부족' : formatAnalysisPrice(point.sma50, currency)}</td>
              <td>{formatVolume(point.volume)}</td>
            </tr>)}</tbody>
          </table>
        </div>
      </details>
    </>}
  </section>
}
