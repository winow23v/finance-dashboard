import { useEffect, useRef, useId, useState } from 'react'
import { Info, X } from 'lucide-react'
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
const wonFormat = new Intl.NumberFormat('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const smallRateFormat = new Intl.NumberFormat('ko-KR', { maximumSignificantDigits: 4 })
const detailFormat = new Intl.NumberFormat('ko-KR', { maximumSignificantDigits: 15 })
const time = new Intl.DateTimeFormat('ko-KR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Seoul' })
const ecbUrl = 'https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html'

function displayRate(value: number, quote: string) {
  if (value !== 0 && Math.abs(value) < (quote === 'KRW' ? 0.005 : 0.00005)) return smallRateFormat.format(value)
  return (quote === 'KRW' ? wonFormat : format).format(value)
}

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

const refreshErrors: Readonly<Record<string, string>> = {
  PROVIDER_UNAVAILABLE: '공급자 HTTP 오류',
  PROVIDER_CONNECTION_ERROR: '공급자 연결 실패',
  PROVIDER_TIMEOUT: '응답 시간 초과',
  PROVIDER_RATE_LIMITED: '공급자 요청 제한',
  PROVIDER_BUSY: '공급자 처리 중',
  PROVIDER_INVALID_JSON: 'JSON 형식 오류',
  PROVIDER_BODY_ERROR: '응답 본문 오류',
  PROVIDER_RESPONSE_TOO_LARGE: '응답 크기 한도 초과',
  INVALID_PROVIDER_RESPONSE: '관측값 검증 실패',
}

function refreshError(code: unknown) {
  if (typeof code !== 'string') return undefined
  return Object.hasOwn(refreshErrors, code) ? refreshErrors[code] : '공급자 갱신 오류'
}

function parseLatest(data: unknown) {
  if (!isRecord(data) || !Array.isArray(data.rates) || !data.rates.every(isRate)
    || new Set(data.rates.map(rate => `${rate.base}/${rate.quote}`)).size !== pairs.length
    || data.rates.length !== pairs.length) throw new Error('Invalid reference rates')
  const reference = data.reference
  const error = refreshError(data.refreshError)
  if (reference === undefined) return { rates: data.rates, refreshError: error }
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
  return { rates: data.rates, refreshError: error, reference: {
    observationDate: reference.observationDate, collectedAt: reference.collectedAt, status: reference.status, table,
  } }
}
function parseHistory(data: unknown) {
  if (!isRecord(data) || !Array.isArray(data.points) || !data.points.every(isPoint)) throw new Error('Invalid rate history')
  return { points: data.points, refreshError: refreshError(data.refreshError) }
}

const latestCache = createRequestCache<ReturnType<typeof parseLatest>>(3, 15 * 60_000)
const historyCache = createRequestCache<ReturnType<typeof parseHistory>>(25, 15 * 60_000)

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

export default function FxDashboard({ revision, detailed, showSettings, onRefreshReady }: {
  revision: number; detailed: boolean; showSettings: boolean; onRefreshReady: (ready: boolean) => void
}) {
  const settings = useRef<HTMLDetailsElement>(null)
  useEffect(() => {
    if (showSettings && settings.current) settings.current.open = true
  }, [showSettings])
  const [preferences, setPreferences] = useState(loadPreferences)
  const { reference, selected, yen100 } = preferences
  const [selection, setPair] = useState(pairs[0])
  const [period, setPeriod] = useState<keyof typeof periods>('1M')
  const latestResult = usePublicData('/api/v1/fx/latest', revision, parseLatest, undefined, true, latestCache)
  const latest = latestResult?.data
  const infoId = useId()
  const availablePairs = [...new Set([...pairs, ...(latest?.reference ? [selection, ...selected.map(code => `${code}/${reference}`)] : [])])]
  const pair = availablePairs.includes(selection) ? selection : pairs[0]
  const [base, quote] = pair.split('/')
  const chartResult = usePublicData(detailed ? '/api/v1/fx/history?' + new URLSearchParams({ base, quote, period }) : undefined, revision, parseHistory, undefined, true, historyCache)
  const chart = chartResult?.data === null ? null : chartResult?.data?.points
  const ready = latestResult?.revision === revision && (!detailed || chartResult?.revision === revision)
  useEffect(() => { onRefreshReady(ready) }, [onRefreshReady, ready])
  const chartMultiplier = base === 'JPY' && yen100 ? 100 : 1

  useEffect(() => { guestPreferences.save(fxKey, preferences) }, [preferences])

  return <section className="market-sections" aria-label="환율">
    <div className="section-heading"><h2>환율</h2><span className="badge">공표 기준환율 · 일별</span></div>
    <details className="panel fx-settings" ref={settings} hidden={!detailed}>
      <summary>환율 설정</summary>
      <div className="fx-preferences">
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
    </details>
    <div className="quote-grid fx-rates">
      {selected.map(code => {
        const name = `${code}/${reference}`
        const row = latestRate(latest, code, reference)
        const multiplier = code === 'JPY' && yen100 ? 100 : 1
        const details = infoId + '-' + code
        const rate = row?.rate
        const unit = reference === 'KRW' ? '원' : reference
        const status = latest?.refreshError ? '갱신 실패 · 이전 공표값'
          : latestResult?.refreshFailed && latestResult.revision === revision ? '갱신 실패 · 이전 값'
          : rate != null && row?.status === 'previous_publication' ? '이전 공표값' : refreshError(latestResult?.errorCode)
        return <article className="panel quote-card fx-quote" key={name}>
          <div className="fx-quote-heading">
            <h3>{name}{multiplier === 100 && <small>100엔 기준</small>}</h3>
            <button type="button" className="fx-info-button" popoverTarget={details} aria-controls={details}
              aria-label={name + ' 환율 정보'}><Info size={17} aria-hidden="true" /></button>
          </div>
          <strong>{rate != null ? <>{displayRate(rate * multiplier, reference)} <span>{unit}</span></>
            : latest === undefined ? '조회 중' : '조회 불가'}</strong>
          {rate != null && row?.observationDate && <small><time dateTime={row.observationDate}>{row.observationDate.replaceAll('-', '.')}</time> 기준</small>}
          {status && <small className="fx-quote-state">{status}</small>}
          <div className="panel fx-info-popover" id={details} popover="auto" role="group" aria-labelledby={details + '-title'}>
            <div className="section-heading">
              <h4 id={details + '-title'}>{name} 환율 정보</h4>
              <button type="button" className="fx-info-button" popoverTarget={details} popoverTargetAction="hide"
                aria-label="환율 정보 닫기"><X size={17} aria-hidden="true" /></button>
            </div>
            <dl className="observation-dates">
              <div><dt>관측일</dt><dd>{row?.observationDate ? <time dateTime={row.observationDate}>{row.observationDate}</time> : '확인 불가'}</dd></div>
              <div><dt>공표 상태</dt><dd>{row ? row.status === 'previous_publication' ? '이전 공표 기준환율' : '최근 공표 기준환율' : '확인 불가'}</dd></div>
              {latest?.refreshError && <div><dt>갱신 실패 원인</dt><dd>{latest.refreshError}</dd></div>}
              <div><dt>수집 시각 (KST)</dt><dd>{row ? <time dateTime={row.collectedAt}>{time.format(new Date(row.collectedAt))}</time> : '확인 불가'}</dd></div>
              <div><dt>계산 방식</dt><dd>{rate == null ? '확인 불가' : row?.calculated ? '같은 관측일의 교차환율' : 'ECB 공표 기준환율'}</dd></div>
              {rate != null && <div><dt>상세 수치</dt><dd>1 {code} = {detailFormat.format(rate)} {unit}
                {multiplier === 100 && <><br />100 {code} = {detailFormat.format(rate * multiplier)} {unit}</>}</dd></div>}
              <div><dt>출처</dt><dd><a href={ecbUrl}>유럽중앙은행 (ECB)</a> · <a href="https://frankfurter.dev/">Frankfurter v2</a></dd></div>
            </dl>
            <a className="fx-info-guide" href="#sources">데이터 출처·이용안내</a>
          </div>
        </article>
      })}
    </div>
    {detailed && <div className="panel chart-panel">
      <div className="panel-heading">
        <div><h2>환율 추이</h2><p>{quote} / {chartMultiplier} {base}</p></div>
        <div className="chart-selects"><select aria-label="통화쌍 선택" value={pair} onChange={event => setPair(event.target.value)}>
          {availablePairs.map(name => <option key={name}>{name}</option>)}
        </select></div>
      </div>
      <div className="chart-toolbar"><div className="periods" role="group" aria-label="환율 기간">
        {(Object.keys(periods) as (keyof typeof periods)[]).map(value =>
          <button key={value} aria-pressed={value === period} onClick={() => setPeriod(value)}>{periods[value]}</button>)}
      </div></div>
      {chartResult?.data?.refreshError && <p className="chart-note" role="status">
        갱신 실패 · 이전 공표 이력 ({chartResult.data.refreshError})
      </p>}
      <div className="chart-body">
        {!chart?.length ? <p className="state" role="status">{chart === undefined ? '조회 중' : chart === null ? refreshError(chartResult?.errorCode) ?? '조회 불가' : '표시할 관측값 없음'}</p>
          : <ResponsiveContainer width="100%" height="100%" minWidth={0}>
            <AreaChart data={chart.map(point => ({ ...point, rate: point.rate * chartMultiplier, dateTime: Date.parse(point.observationDate) }))} margin={{ top: 10, right: 12, left: 12, bottom: 8 }}>
              <CartesianGrid vertical={false} stroke="var(--line)" strokeDasharray="4 5" />
              <XAxis dataKey="dateTime" type="number" scale="time" domain={['dataMin', 'dataMax']} tickFormatter={date => new Date(date).toISOString().slice(5, 10)} minTickGap={28} tick={{ fill: 'var(--muted)', fontSize: 12 }} />
              <YAxis orientation="right" width={65} domain={['auto', 'auto']} tickFormatter={value => displayRate(value, quote)} tick={{ fill: 'var(--muted)', fontSize: 12 }} />
              <Tooltip labelFormatter={date => new Date(Number(date)).toISOString().slice(0, 10)} formatter={value => `${detailFormat.format(Number(value))} ${quote}`} contentStyle={{ background: 'var(--panel)', borderColor: 'var(--line)' }} />
              <Area name={pair} dataKey="rate" stroke="var(--accent)" fill="var(--accent)" fillOpacity={0.09} isAnimationActive={false} dot={chart.length === 1} />
            </AreaChart>
          </ResponsiveContainer>}
      </div>
      <p className="chart-note"><a href={ecbUrl}>ECB</a> · <a href="https://frankfurter.dev/">Frankfurter v2</a></p>
    </div>}
  </section>
}
