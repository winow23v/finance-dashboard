import { ChartNoAxesCombined } from 'lucide-react'
import { useId, useMemo, useState } from 'react'
import { Bar, CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { formatAnalysisPrice, formatVolume } from '../services/analysisPrices'
import { technicalChartSeries } from '../services/technicalIndicators'
import type { MarketDailyHistory } from '../types/marketDataProvider'

const periods = [20, 60, 120] as const
const averages = [
  { days: 20, key: 'ema20', name: 'EMA 20', color: 'var(--blue)' },
  { days: 50, key: 'ema50', name: 'EMA 50', color: 'var(--favorite)' },
  { days: 100, key: 'ema100', name: 'EMA 100', color: 'var(--green)' },
  { days: 200, key: 'ema200', name: 'EMA 200', color: 'var(--red)' },
  { days: 365, key: 'sma365', name: 'SMA 365', color: 'var(--muted)' },
] as const

type CandleProps = {
  x?: number; y?: number; width?: number; height?: number
  payload?: { open: number; high: number; low: number; close: number }
}

function Candle({ x = 0, y = 0, width = 0, height = 0, payload, domestic }: CandleProps & { domestic: boolean }) {
  if (!payload) return null
  const { open, high, low, close } = payload
  const color = close === open ? 'var(--muted)' : close > open
    ? domestic ? 'var(--red)' : 'var(--green)' : domestic ? 'var(--blue)' : 'var(--red)'
  const priceY = (value: number) => high === low ? y : y + height * (high - value) / (high - low)
  const top = priceY(Math.max(open, close))
  const bottom = priceY(Math.min(open, close))
  return <g fill={color} stroke={color}>
    <line x1={x + width / 2} x2={x + width / 2} y1={y} y2={y + height} />
    <rect x={x} y={top} width={width} height={Math.max(bottom - top, 1)} stroke="none" />
  </g>
}
const axisNumber = new Intl.NumberFormat('ko-KR', { notation: 'compact', maximumFractionDigits: 1 })
const axisTick = { fill: 'var(--muted)', fontSize: 11 }
const tooltip = { background: 'var(--panel)', color: 'var(--text)', borderColor: 'var(--line)', borderRadius: 8 }
const grid = { stroke: 'var(--line)', strokeDasharray: '4 5', vertical: false }
const margin = { top: 6, right: 10, left: 4, bottom: 0 }

export default function StockHistoryChart({ history }: { history: MarketDailyHistory }) {
  const [period, setPeriod] = useState<(typeof periods)[number]>(60)
  const [priceView, setPriceView] = useState<'close' | 'candle'>('close')
  const [momentum, setMomentum] = useState<'off' | 'rsi' | 'macd'>('off')
  const [selected, setSelected] = useState(new Set<string>(['ema20', 'ema50']))
  const id = useId()
  const tooltipTrigger = matchMedia('(hover: none)').matches ? 'click' : 'hover'
  const { bars, currency } = history
  const basis = history.adjustment === 'total-return-adjusted' ? '배당·분할 조정 종가'
    : history.adjustment === 'split-adjusted' ? '분할 조정 종가' : '미수정 종가'
  const series = useMemo(() => technicalChartSeries(history), [history])
  const points = series.slice(-period)
  const hasVolume = points.some(point => point.volume > 0)
  const visibleAverages = averages.filter(({ key }) => selected.has(key) && points.some(point => point[key] !== null))
  const momentumAvailable = points.some(point => momentum === 'rsi' ? point.rsi !== null : point.histogram !== null)
  const dateAxis = <XAxis dataKey="tradingDate" tickFormatter={value => String(value).slice(5)} minTickGap={24}
    interval="preserveStartEnd" tick={axisTick} tickMargin={7} tickLine={false} axisLine={false} />
  const axis = { orientation: 'right' as const, width: 52, tickFormatter: (value: number) => axisNumber.format(value),
    tick: axisTick, tickLine: false, axisLine: false }

  return <section className="stock-history" aria-labelledby={id}>
    <div className="analysis-heading">
      <div><h2 id={id}><ChartNoAxesCombined size={17} aria-hidden="true" /> 가격 추이</h2>
        <small>{basis} · {currency}</small></div>
      {bars.length > 0 && <div className="periods" role="group" aria-label="차트 기간">
        {periods.map(days => <button type="button" key={days} aria-pressed={period === days}
          onClick={() => setPeriod(days)}>{days}일</button>)}
      </div>}
    </div>
    <p className="stock-history-range">{points.length ? <>
      확보한 일봉 {bars.length}개 중 {points.length}거래일 · <time dateTime={points[0].tradingDate}>{points[0].tradingDate}</time>
      {' ~ '}<time dateTime={points.at(-1)?.tradingDate}>{points.at(-1)?.tradingDate}</time>
    </> : '유효한 일봉 데이터가 없습니다.'}</p>
    {points.length > 0 && history.completeness === 'missing-observations' && <p className="stock-history-range">
      수집된 일봉만 표시합니다. 일부 거래일의 관측값이 없습니다.
    </p>}
    {points.length === 1 && <p className="state" role="status">일봉이 1개뿐이어서 가격 추이를 비교할 수 없습니다.</p>}
    {points.length > 0 && <>
      <div className="periods" role="group" aria-label="가격 차트 표시">
        <button type="button" aria-pressed={priceView === 'close'} onClick={() => setPriceView('close')}>종가</button>
        <button type="button" aria-pressed={priceView === 'candle'} onClick={() => setPriceView('candle')}>캔들</button>
      </div>
      <div className="periods" role="group" aria-label="이동평균선">
        {averages.map(({ key, name }) => {
          const available = points.some(point => point[key] !== null)
          return <button type="button" key={key} aria-pressed={selected.has(key) && available} disabled={!available}
            onClick={() => setSelected(current => {
              const next = new Set(current)
              if (next.has(key)) next.delete(key)
              else next.add(key)
              return next
            })}>{name}{!available && ' · 자료 부족'}</button>
        })}
      </div>
      <div className="stock-price-plot">
        <ResponsiveContainer width="100%" height="100%" minWidth={0}>
          <ComposedChart data={points} margin={margin} title={basis + ' 차트'} accessibilityLayer syncId={id}>
            <CartesianGrid {...grid} />
            {dateAxis}
            <YAxis {...axis} domain={['auto', 'auto']} />
            <Tooltip trigger={tooltipTrigger} isAnimationActive={false} wrapperClassName="terminal-chart-tooltip" allowEscapeViewBox={{ x: false, y: false }} contentStyle={tooltip} itemStyle={{ color: 'var(--text)' }}
              formatter={value => typeof value === 'number' ? formatAnalysisPrice(value, currency) :
                Array.isArray(value) ? value.map(price => formatAnalysisPrice(Number(price), currency)).join(' ~ ') : '자료 부족'} />
            {priceView === 'candle' ? <Bar dataKey="candleRange" name="일중 범위" maxBarSize={12}
              shape={<Candle domestic={currency === 'KRW'} />} isAnimationActive={false} /> :
              <Line dataKey="close" name={basis} stroke="var(--accent)" strokeWidth={2} dot={points.length === 1}
                isAnimationActive={false} />}
            {visibleAverages.map(({ key, name, color }) => <Line key={key} dataKey={key} name={name} stroke={color}
              strokeWidth={2} strokeDasharray="5 3" dot={false} isAnimationActive={false} />)}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <h3 className="stock-volume-heading">거래량 <small>단위 · 주</small></h3>
      {hasVolume ? <div className="stock-volume-plot">
        <ResponsiveContainer width="100%" height="100%" minWidth={0}>
          <ComposedChart data={points} margin={margin} title="거래량 차트" accessibilityLayer syncId={id}>
            <CartesianGrid {...grid} />
            {dateAxis}
            <YAxis {...axis} />
            <Tooltip trigger={tooltipTrigger} isAnimationActive={false} wrapperClassName="terminal-chart-tooltip" allowEscapeViewBox={{ x: false, y: false }} contentStyle={tooltip} itemStyle={{ color: 'var(--text)' }}
              formatter={value => typeof value === 'number' ? formatVolume(value) : '자료 부족'} />
            <Bar dataKey="volume" name="거래량" fill="var(--blue)" isAnimationActive={false} />
            <Line dataKey="volume20" name="거래량 평균 20" stroke="var(--favorite)" dot={false} isAnimationActive={false} />
            <Line dataKey="volume50" name="거래량 평균 50" stroke="var(--green)" dot={false} isAnimationActive={false} />
          </ComposedChart>
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
      <div className="periods" role="group" aria-label="모멘텀 차트">
        {(['off', 'rsi', 'macd'] as const).map(key => <button type="button" key={key} aria-pressed={momentum === key}
          onClick={() => setMomentum(key)}>{{ off: '닫기', rsi: 'RSI 14', macd: 'MACD' }[key]}</button>)}
      </div>
      {momentum !== 'off' && (momentumAvailable ? <div className="stock-volume-plot">
        <ResponsiveContainer width="100%" height="100%" minWidth={0}>
          <ComposedChart data={points} margin={margin} title={momentum === 'rsi' ? 'RSI 14' : 'MACD'} accessibilityLayer syncId={id}>
            <CartesianGrid {...grid} />{dateAxis}<YAxis {...axis} domain={momentum === 'rsi' ? [0, 100] : ['auto', 'auto']} />
            <Tooltip trigger={tooltipTrigger} isAnimationActive={false} contentStyle={tooltip} />
            {momentum === 'rsi' ? <>
              <ReferenceLine y={30} stroke="var(--muted)" strokeDasharray="4 4" />
              <ReferenceLine y={70} stroke="var(--muted)" strokeDasharray="4 4" />
              <Line dataKey="rsi" name="RSI 14" stroke="var(--accent)" dot={false} isAnimationActive={false} />
            </> : <>
              <Bar dataKey="histogram" name="히스토그램" fill="var(--muted)" isAnimationActive={false} />
              <Line dataKey="macd" name="MACD" stroke="var(--accent)" dot={false} isAnimationActive={false} />
              <Line dataKey="signal" name="시그널" stroke="var(--favorite)" dot={false} isAnimationActive={false} />
            </>}
          </ComposedChart>
        </ResponsiveContainer>
      </div> : <p role="status" className="state">지표 산출 자료 부족</p>)}
    </>}
  </section>
}
