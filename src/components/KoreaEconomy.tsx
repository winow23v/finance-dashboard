import { LoadingSkeleton } from "./LoadingSkeleton"
import { lazy, Suspense, useEffect, useId, useState } from 'react'
import { isNumber, isRecord } from '../services/apiFinanceService'
import { ecosRefreshFailed } from '../services/ecosRefresh'
import { createRequestCache } from '../services/requestCache'
import { usePublicData } from '../services/usePublicData'
import type { EcosPoint } from './EcosHistoryChart'

const EcosHistoryChart = lazy(() => import('./EcosHistoryChart'))

const indicators = [
  { id: 'base-rate', name: '한국은행 기준금리' },
  { id: 'cpi', name: '소비자물가지수' },
  { id: 'unemployment', name: '실업률 (원계열)' },
]
const twoDecimals = new Intl.NumberFormat('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const oneDecimal = new Intl.NumberFormat('ko-KR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })

function validHistory(value: unknown, daily: boolean): EcosPoint[] {
  if (!Array.isArray(value) || value.length > (daily ? 90 : 24)) return []
  const byPeriod = new Map<string, number>()
  for (const row of value) {
    if (!isRecord(row) || typeof row.period !== 'string' || !isNumber(row.value) ||
      !(daily ? /^\d{4}-\d{2}-\d{2}$/ : /^\d{4}-\d{2}$/).test(row.period)) return []
    const date = daily ? row.period : row.period + '-01'
    const instant = new Date(date)
    if (!Number.isFinite(+instant) || instant.toISOString().slice(0, 10) !== date || byPeriod.has(row.period)) return []
    byPeriod.set(row.period, row.value)
  }
  return [...byPeriod].sort(([left], [right]) => left.localeCompare(right)).map(([period, value]) => ({ period, value }))
}

function parseIndicators(value: unknown) {
  if (!isRecord(value) || !Array.isArray(value.indicators)) throw new Error('Invalid ECOS response')
  return value.indicators.map((item: unknown) => {
    if (!isRecord(item) || typeof item.id !== 'string') throw new Error('Invalid ECOS indicator')
    if (item.status === 'unavailable') return { id: item.id, status: 'unavailable' as const, code: typeof item.code === 'string' ? item.code.trim() : undefined }
    if (item.status !== 'published' || !isNumber(item.value) || typeof item.unit !== 'string' || (typeof item.observationDate !== 'string' && typeof item.observationPeriod !== 'string')
      || (item.releaseDate !== null && typeof item.releaseDate !== 'string')
      || typeof item.collectedAt !== 'string' || !Number.isFinite(Date.parse(item.collectedAt))) throw new Error('Invalid ECOS observation')
    const period = item.observationPeriod
    const comparison = item.yearOverYear
    const yearOverYear = item.id === 'cpi' && typeof period === 'string' && /^\d{4}-\d{2}$/.test(period) &&
      isRecord(comparison) && isNumber(comparison.value) &&
      comparison.comparisonPeriod === `${Number(period.slice(0, 4)) - 1}${period.slice(4)}`
      ? { value: comparison.value, period: comparison.comparisonPeriod } : undefined
    return { id: item.id, status: 'published' as const, value: item.value, unit: item.unit,
      observationDate: typeof item.observationDate === 'string' ? item.observationDate : undefined,
      observationPeriod: typeof period === 'string' ? period : undefined,
      releaseDate: item.releaseDate, collectedAt: item.collectedAt, yearOverYear,
      history: validHistory(item.history, item.id === 'base-rate') }
  })
}

const ecosCache = createRequestCache<ReturnType<typeof parseIndicators>>(2, 5 * 60_000)

export function KoreaEconomy({ revision, visible, onRefreshReady, onRefreshResult }: { revision: number; visible: boolean; onRefreshReady: (ready: boolean) => void; onRefreshResult?: (key: string, failed: boolean) => void }) {
  const result = usePublicData('/api/v1/economy/korea', revision, parseIndicators, undefined, true, ecosCache)
  const ready = result?.revision === revision
  useEffect(() => { onRefreshReady(ready) }, [onRefreshReady, ready])
  const failed = ready && ecosRefreshFailed(result)
  useEffect(() => { if (ready) onRefreshResult?.('ecos', failed) }, [ready, failed, revision, onRefreshResult])
  const data = result?.data
  const rateLimited = result?.errorCode === 'PROVIDER_RATE_LIMITED'
  const [selected, setSelected] = useState<string>()
  const chartId = useId()
  const current = data?.find(item => item.id === selected)
  const name = indicators.find(item => item.id === selected)?.name
  return <section className="market-sections" aria-label="한국 경제지표">
    <div className="section-heading"><h2>한국 경제지표</h2></div>
    {result?.refreshFailed && result.revision === revision && <p className="data-message" data-state="stale" role="status">갱신에 실패해 이전 조회값을 표시합니다.</p>}
    <div className="quote-grid ecos-indicators">
      {indicators.map(({ id, name }) => {
        const row = data?.find(item => item.id === id)
        const hasHistory = (row?.history?.length ?? 0) >= 2
        return <article className={hasHistory ? 'panel quote-card indicator-has-chart' : 'panel quote-card'} key={id}>
          <div className="quote-label"><h3>{name}</h3></div>
          <strong className="economic-value" data-state={row?.value !== undefined ? undefined : data === undefined ? 'loading'
            : (rateLimited || row?.code === 'PROVIDER_RATE_LIMITED') ? 'rate-limited' : data === null || row?.code ? 'error' : 'unpublished'}>{row?.value !== undefined
            ? `${(id === 'unemployment' ? oneDecimal : twoDecimals).format(row.value)}${id === 'cpi' ? '' : ' ' + row.unit}`
            : data === undefined ? <LoadingSkeleton message="한국 경제지표를 불러오는 중입니다." shape="value" /> : (rateLimited || row?.code === 'PROVIDER_RATE_LIMITED') ? '요청 한도 초과' : data === null || row?.code ? '조회 불가' : '공표 관측값 없음'}</strong>
          {id === 'cpi' && row?.value !== undefined && <small>기준연도 {row.unit}{!row.yearOverYear && ' / 전년 동월 대비 계산 불가'}</small>}
          {row?.yearOverYear && <small>전년 동월 대비 {twoDecimals.format(row.yearOverYear.value)}% · 비교월 <time dateTime={row.yearOverYear.period}>{row.yearOverYear.period}</time></small>}
          {row?.collectedAt && <>
            <small><time dateTime={row.observationDate ?? row.observationPeriod}>{row.observationDate ?? row.observationPeriod}</time> 관측 기준</small>
            <details className="indicator-observation"><summary>관측 정보</summary>
              <dl className="observation-dates">
                {row.releaseDate && <div><dt>공표일</dt><dd><time dateTime={row.releaseDate}>{row.releaseDate}</time></dd></div>}
                <div><dt>출처</dt><dd>한국은행 ECOS</dd></div>
              </dl>
            </details>
          </>}
          {visible && hasHistory && <button type="button" className="button indicator-chart-button" id={chartId + id}
            aria-label={name + ' 상세 차트'} aria-expanded={selected === id} aria-controls={selected === id ? chartId : undefined}
            onClick={() => setSelected(previous => previous === id ? undefined : id)}>상세 차트</button>}
        </article>
      })}
    </div>
    {visible && name && current?.collectedAt && current.unit && current.history && current.history.length >= 2 && <Suspense fallback={<LoadingSkeleton message="차트를 준비하는 중입니다." shape="chart" />}>
      <EcosHistoryChart id={chartId} name={name} unit={current.unit} points={current.history} onClose={() => {
        document.getElementById(chartId + selected)?.focus()
        setSelected(undefined)
      }} />
    </Suspense>}
  </section>
}
