import { useEffect, useState } from 'react'
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { isNumber, isRecord } from '../services/apiFinanceService'

import { createRequestCache } from '../services/requestCache'
import { guestPreferences } from '../storage/guestStorage'
import { usePublicData } from '../services/usePublicData'

const pairs = ['USD/KRW', 'EUR/KRW', 'USD/JPY']
const currencies = ['KRW', 'USD', 'JPY', 'EUR', 'CNY', 'GBP', 'CHF', 'AUD', 'CAD'] as const
type Currency = typeof currencies[number]
const maxCurrencies = 5
const fxKey = 'finance.fx'

function isCurrency(value: unknown): value is Currency {
  return currencies.some(code => code === value)
}

function loadPreferences() {
  const stored = guestPreferences.load(fxKey)
  const value = isRecord(stored) ? stored : {}
  const reference = isCurrency(value.reference) ? value.reference : 'KRW'
  const selected = Array.isArray(value.selected)
    ? [...new Set(value.selected.filter(isCurrency))].filter(code => code !== reference).slice(0, maxCurrencies)
    : []
  const defaults: Currency[] = ['USD', 'JPY', 'EUR']
  return { reference, selected: selected.length ? selected : defaults.filter(code => code !== reference), yen100: value.yen100 !== false }
}
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
  const reference = data.reference
  if (reference === undefined) return { rates: data.rates }
  if (!isRecord(reference) || reference.kind !== 'reference' || !isDate(reference.observationDate)
    || typeof reference.collectedAt !== 'string' || !Number.isFinite(Date.parse(reference.collectedAt))
    || (reference.status !== 'published_today' && reference.status !== 'previous_publication') || !isRecord(reference.rates)) {
    throw new Error('Invalid ECB reference table')
  }
  const table: Partial<Record<Currency, Partial<Record<Currency, number | null>>>> = {}
  for (const base of currencies) {
    const row = reference.rates[base]
    if (!isRecord(row)) throw new Error('Invalid ECB currency')
    const values: Partial<Record<Currency, number | null>> = {}
    for (const quote of currencies) {
      if (quote === base) continue
      const rate = row[quote]
      if (rate !== null && (!isNumber(rate) || rate <= 0)) throw new Error('Invalid ECB cross rate')
      values[quote] = rate
    }
    table[base] = values
  }
  return { rates: data.rates, reference: {
    observationDate: reference.observationDate, collectedAt: reference.collectedAt, status: reference.status, table,
  } }
}
function parseHistory(data: unknown) {
  if (!isRecord(data) || !Array.isArray(data.points) || !data.points.every(isPoint)) throw new Error('Invalid rate history')
  return data.points
}

const latestCache = createRequestCache<ReturnType<typeof parseLatest>>(3, 15 * 60_000)
const historyCache = createRequestCache<Point[]>(25, 15 * 60_000)

function latestRate(latest: ReturnType<typeof parseLatest> | null | undefined, base: Currency, quote: Currency) {
  if (latest?.reference) return {
    ...latest.reference, rate: latest.reference.table[base]?.[quote] ?? null, calculated: base !== 'EUR',
  }
  const legacy = latest?.rates.find(row => row.base === base && row.quote === quote)
  if (legacy) return legacy
  const inverse = latest?.rates.find(row => row.base === quote && row.quote === base)
  if (inverse?.rate != null) return { ...inverse, rate: 1 / inverse.rate, calculated: true }
  const inKrw = latest?.rates.find(row => row.base === 'USD' && row.quote === 'KRW')
  const inYen = latest?.rates.find(row => row.base === 'USD' && row.quote === 'JPY')
  if (base === 'JPY' && quote === 'KRW' && inKrw?.rate != null && inYen?.rate != null && inKrw.observationDate === inYen.observationDate) {
    return { ...inKrw, rate: inKrw.rate / inYen.rate, calculated: true }
  }
}

export default function FxDashboard({ revision }: { revision: number }) {
  const [preferences, setPreferences] = useState(loadPreferences)
  const { reference, selected, yen100 } = preferences
  const [selection, setPair] = useState(pairs[0])
  const [period, setPeriod] = useState<keyof typeof periods>('1M')
  const latest = usePublicData('/api/v1/fx/latest', revision, parseLatest, undefined, true, latestCache)?.data
  const availablePairs = [...new Set([...pairs, ...(latest?.reference ? [selection, ...selected.map(code => `${code}/${reference}`)] : [])])]
  const pair = availablePairs.includes(selection) ? selection : pairs[0]
  const [base, quote] = pair.split('/')
  const chart = usePublicData('/api/v1/fx/history?' + new URLSearchParams({ base, quote, period }), revision, parseHistory, undefined, true, historyCache)?.data
  const chartMultiplier = base === 'JPY' && yen100 ? 100 : 1

  useEffect(() => { guestPreferences.save(fxKey, preferences) }, [preferences])

  return <section className="market-sections" aria-label="환율">
    <div className="section-heading"><h2>환율</h2><span className="badge">공표 기준환율 · 일별</span></div>
    <div className="panel fx-preferences">
      <label>기준 통화 <select value={reference} onChange={event => {
        const value = event.target.value
        if (!isCurrency(value)) return
        setPreferences(previous => {
          const next = previous.selected.filter(code => code !== value)
          return { ...previous, reference: value, selected: next.length ? next : [previous.reference] }
        })
      }}>{currencies.map(code => <option key={code}>{code}</option>)}</select></label>
      <fieldset><legend>표시 통화 · 최대 {maxCurrencies}개</legend>
        <div className="currency-options">{currencies.filter(code => code !== reference).map(code => {
          const checked = selected.includes(code)
          return <label key={code}><input type="checkbox" checked={checked}
            disabled={checked ? selected.length === 1 : selected.length >= maxCurrencies}
            onChange={() => setPreferences(previous => ({ ...previous, selected: checked
              ? previous.selected.filter(item => item !== code) : [...previous.selected, code] }))} /> {code}</label>
        })}</div>
      </fieldset>
      <label><input type="checkbox" checked={yen100} onChange={event => setPreferences({ ...preferences, yen100: event.target.checked })} /> 일본 엔화 100엔 기준</label>
    </div>
    <div className="quote-grid">
      {selected.map(code => {
        const name = `${code}/${reference}`
        const row = latestRate(latest, code, reference)
        const multiplier = code === 'JPY' && yen100 ? 100 : 1
        return <article className="panel quote-card" key={name}>
          <div className="quote-label"><h3>{name}</h3><span>{reference} / {multiplier} {code}</span></div>
          <strong>{row?.rate != null ? format.format(row.rate * multiplier) : latest === undefined ? '조회 중' : '조회 불가'}</strong>
          {row?.observationDate && row.rate !== null && <small>관측일 <time dateTime={row.observationDate}>{row.observationDate}</time> · {row.status === 'published_today' ? '당일 공표' : '이전 공표값'}{row.calculated && ' · 교차환율 계산'}</small>}
          {row && <small>수집 (KST) <time dateTime={row.collectedAt}>{time.format(new Date(row.collectedAt))}</time></small>}
        </article>
      })}
    </div>
    <div className="panel chart-panel">
      <div className="panel-heading">
        <div><h2>환율 추이</h2><p>{quote} / {chartMultiplier} {base}{base !== 'EUR' && ' · ECB 기준환율을 사용한 교차환율'}</p></div>
        <div className="chart-selects"><select aria-label="통화쌍 선택" value={pair} onChange={event => setPair(event.target.value)}>
          {availablePairs.map(name => <option key={name}>{name}</option>)}
        </select></div>
      </div>
      <div className="chart-toolbar"><div className="periods" role="group" aria-label="환율 기간">
        {(Object.keys(periods) as (keyof typeof periods)[]).map(value =>
          <button key={value} aria-pressed={value === period} onClick={() => setPeriod(value)}>{periods[value]}</button>)}
      </div></div>
      <div className="chart-body">
        {!chart?.length ? <p className="state" role="status">{chart === undefined ? '조회 중' : chart === null ? '조회 불가' : '표시할 관측값 없음'}</p>
          : <ResponsiveContainer width="100%" height="100%" minWidth={0}>
            <AreaChart data={chart.map(point => ({ ...point, rate: point.rate * chartMultiplier, dateTime: Date.parse(point.observationDate) }))} margin={{ top: 10, right: 12, left: 12, bottom: 8 }}>
              <CartesianGrid vertical={false} stroke="var(--line)" strokeDasharray="4 5" />
              <XAxis dataKey="dateTime" type="number" scale="time" domain={['dataMin', 'dataMax']} tickFormatter={date => new Date(date).toISOString().slice(5, 10)} minTickGap={28} tick={{ fill: 'var(--muted)', fontSize: 12 }} />
              <YAxis orientation="right" width={65} domain={['auto', 'auto']} tickFormatter={value => format.format(value)} tick={{ fill: 'var(--muted)', fontSize: 12 }} />
              <Tooltip labelFormatter={date => new Date(Number(date)).toISOString().slice(0, 10)} formatter={value => `${format.format(Number(value))} ${quote}`} contentStyle={{ background: 'var(--panel)', borderColor: 'var(--line)' }} />
              <Area name={pair} dataKey="rate" stroke="var(--accent)" fill="var(--accent)" fillOpacity={0.09} isAnimationActive={false} dot={chart.length === 1} />
            </AreaChart>
          </ResponsiveContainer>}
      </div>
      <p className="chart-note">공표 기준환율이며 실시간 매매 호가는 제공하지 않습니다. 출처 <a href="https://frankfurter.dev/">Frankfurter v2</a> · <a href="https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html">유럽중앙은행 (ECB)</a></p>
    </div>
  </section>
}
