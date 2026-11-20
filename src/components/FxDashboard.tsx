import { useState } from 'react'
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { isNumber, isRecord } from '../services/apiFinanceService'

import { usePublicData } from '../services/usePublicData'

const pairs = ['USD/KRW', 'EUR/KRW', 'USD/JPY']
const periods = { '1W': '7일', '1M': '1개월', '3M': '3개월', '1Y': '1년' }
const format = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 4 })
const time = new Intl.DateTimeFormat('ko-KR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Seoul' })

type Point = { observationDate: string; rate: number }
type Rate = {
  base: string; quote: string; unit: string; rate: number | null; observationDate: string | null
  collectedAt: string; status: 'unavailable' | 'published_today' | 'previous_publication'; calculated: boolean
}

function isDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value))
}
function isPoint(value: unknown): value is Point {
  return isRecord(value) && isDate(value.observationDate) && isNumber(value.rate) && value.rate > 0
}
function isRate(value: unknown): value is Rate {
  if (!isRecord(value) || !pairs.includes(`${value.base}/${value.quote}`)
    || value.unit !== `${value.quote} / 1 ${value.base}` || value.kind !== 'reference'
    || typeof value.calculated !== 'boolean' || typeof value.collectedAt !== 'string'
    || !Number.isFinite(Date.parse(value.collectedAt))) return false
  return value.status === 'unavailable' ? value.rate === null && value.observationDate === null
    : (value.status === 'published_today' || value.status === 'previous_publication') && isPoint(value)
}

function parseLatest(data: unknown) {
  if (!isRecord(data) || !Array.isArray(data.rates) || !data.rates.every(isRate)
    || new Set(data.rates.map(rate => `${rate.base}/${rate.quote}`)).size !== pairs.length
    || data.rates.length !== pairs.length) throw new Error('Invalid reference rates')
  return data.rates
}
function parseHistory(data: unknown) {
  if (!isRecord(data) || !Array.isArray(data.points) || !data.points.every(isPoint)) throw new Error('Invalid rate history')
  return data.points
}

export default function FxDashboard({ revision }: { revision: number }) {
  const [pair, setPair] = useState(pairs[0])
  const [period, setPeriod] = useState<keyof typeof periods>('1M')
  const [base, quote] = pair.split('/')
  const latest = usePublicData('/api/v1/fx/latest', revision, parseLatest)?.data
  const chart = usePublicData('/api/v1/fx/history?' + new URLSearchParams({ base, quote, period }), revision, parseHistory)?.data

  return <section className="market-sections" aria-label="환율">
    <div className="section-heading"><h2>환율</h2><span className="badge">공표 기준환율 · 일별</span></div>
    <div className="quote-grid">
      {pairs.map(name => {
        const row = latest?.find(item => `${item.base}/${item.quote}` === name)
        return <article className="panel quote-card" key={name}>
          <div className="quote-label"><h3>{name}</h3>{row && <span>{row.unit}</span>}</div>
          <strong>{row?.rate != null ? format.format(row.rate) : latest === undefined ? '조회 중' : '조회 불가'}</strong>
          {row?.observationDate && <small>관측일 <time dateTime={row.observationDate}>{row.observationDate}</time> · {row.status === 'published_today' ? '당일 공표' : '이전 공표값'}{row.calculated && ' · 교차환율 계산'}</small>}
          {row && <small>수집 (KST) <time dateTime={row.collectedAt}>{time.format(new Date(row.collectedAt))}</time></small>}
        </article>
      })}
    </div>
    <div className="panel chart-panel">
      <div className="panel-heading">
        <div><h2>환율 추이</h2><p>{quote} / 1 {base}{base !== 'EUR' && ' · ECB 기준환율을 사용한 교차환율'}</p></div>
        <div className="chart-selects"><select aria-label="통화쌍 선택" value={pair} onChange={event => setPair(event.target.value)}>
          {pairs.map(name => <option key={name}>{name}</option>)}
        </select></div>
      </div>
      <div className="chart-toolbar"><div className="periods" role="group" aria-label="환율 기간">
        {(Object.keys(periods) as (keyof typeof periods)[]).map(value =>
          <button key={value} aria-pressed={value === period} onClick={() => setPeriod(value)}>{periods[value]}</button>)}
      </div></div>
      <div className="chart-body">
        {!chart?.length ? <p className="state" role="status">{chart === undefined ? '조회 중' : '조회 불가'}</p>
          : <ResponsiveContainer width="100%" height="100%" minWidth={0}>
            <AreaChart data={chart.map(point => ({ ...point, dateTime: Date.parse(point.observationDate) }))} margin={{ top: 10, right: 12, left: 12, bottom: 8 }}>
              <CartesianGrid vertical={false} stroke="var(--line)" strokeDasharray="4 5" />
              <XAxis dataKey="dateTime" type="number" scale="time" domain={['dataMin', 'dataMax']} tickFormatter={date => new Date(date).toISOString().slice(5, 10)} minTickGap={28} tick={{ fill: 'var(--muted)', fontSize: 12 }} />
              <YAxis orientation="right" width={65} domain={['auto', 'auto']} tickFormatter={value => format.format(value)} tick={{ fill: 'var(--muted)', fontSize: 12 }} />
              <Tooltip labelFormatter={date => new Date(Number(date)).toISOString().slice(0, 10)} formatter={value => `${format.format(Number(value))} ${quote}`} contentStyle={{ background: 'var(--panel)', borderColor: 'var(--line)' }} />
              <Area name={pair} dataKey="rate" stroke="var(--accent)" fill="var(--accent)" fillOpacity={0.09} isAnimationActive={false} dot={chart.length === 1} />
            </AreaChart>
          </ResponsiveContainer>}
      </div>
      <p className="chart-note">출처 <a href="https://frankfurter.dev/">Frankfurter v2</a> · <a href="https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html">유럽중앙은행 (ECB)</a></p>
    </div>
  </section>
}
