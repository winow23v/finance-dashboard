import { LoadingSkeleton } from "./LoadingSkeleton"
import { useEffect, useState } from 'react'
import { ChartNoAxesCombined } from 'lucide-react'
import { FinanceApiError, getEconomyIndicators } from '../services/apiFinanceService'
import type { EconomyIndicators, Indicator } from '../types/finance'

const percent = new Intl.NumberFormat('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const indexValue = new Intl.NumberFormat('ko-KR', { minimumFractionDigits: 3, maximumFractionDigits: 3 })
const pointChange = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 3, signDisplay: 'exceptZero' })

const frequencyLabels = { daily: '일별', 'daily-7-day': '일별 · 주 7일', monthly: '월별' }

type EconomyResult =
  | { status: 'loaded'; data: EconomyIndicators | null }
  | { status: 'error'; message: string; rateLimited: boolean }

export function Economics({ api, demo, detailed, revision, onRefreshReady, onRefreshResult }: {
  api: boolean; demo?: Indicator[]; detailed: boolean; revision: number; onRefreshReady: (ready: boolean) => void; onRefreshResult?: (key: string, failed: boolean) => void
}) {
  const [attempt, setAttempt] = useState(0)
  const [result, setResult] = useState<{ revision: number; attempt: number; result: EconomyResult }>()
  const current = result?.revision === revision && result.attempt === attempt ? result.result : undefined

  const ready = current !== undefined
  useEffect(() => { onRefreshReady(ready) }, [onRefreshReady, ready])

  useEffect(() => {
    if (!api) return
    const controller = new AbortController()
    function finish(result: EconomyResult) {
      if (!controller.signal.aborted) setResult({ revision, attempt, result })
    }
    getEconomyIndicators(controller.signal).then(
      data => finish({ status: 'loaded', data }),
      error => {
        const code = error instanceof FinanceApiError ? error.code : undefined
        const rateLimited = code === 'FRED_RATE_LIMITED' || (error instanceof FinanceApiError && error.status === 429)
        const message = code === 'FRED_CONFIGURATION_MISSING' ? '서버의 FRED 연결 설정을 확인하지 못했습니다.'
          : code === 'FRED_AUTH_REJECTED' || code === 'FRED_ACCESS_DENIED' ? 'FRED 공급자가 조회를 허용하지 않았습니다.'
          : rateLimited ? 'FRED 요청 한도에 도달했습니다. 잠시 후 다시 시도해 주세요.'
          : '경제지표를 불러오지 못했습니다.'
        finish({ status: 'error', message, rateLimited })
      },
    )
    return () => controller.abort()
  }, [api, revision, attempt])

  const live = current?.status === 'loaded' ? current.data : undefined
  const refreshFailed = current?.status === 'error'
  useEffect(() => { if (ready) onRefreshResult?.('fred', refreshFailed) }, [ready, refreshFailed, revision, onRefreshResult])
  const rows = api ? live?.indicators : demo
  return <section className="panel economy-panel">
    <div className="panel-heading">
      <div><h2><ChartNoAxesCombined size={17} aria-hidden="true" /> 주요 경제지표</h2><p>미국 거시경제 지표</p></div>
      {(!api || live) && <span className="badge">{api ? '공표 관측값' : 'DEMO · 샘플 데이터'}</span>}
    </div>
    {api && !current && <p className="state data-message" data-state="loading" role="status">경제지표를 불러오는 중입니다.</p>}
    {api && current?.status === 'error' && <div className="state data-message" data-state={current.rateLimited ? 'rate-limited' : 'error'}>
      <p role="alert">{current.message}</p>
      <button className="button" onClick={() => setAttempt(value => value + 1)}>다시 시도</button>
    </div>}
    {api && live === null && <p className="state data-message" data-state="unavailable" role="status">FRED 실데이터 연동이 꺼져 있습니다.</p>}
    {(!api && !rows?.length) && <p className="state data-message" data-state="empty" role="status">표시할 경제지표가 없습니다.</p>}
    {!!rows?.length && <ul className={detailed ? 'indicator-list indicator-detail' : 'indicator-list'}>
      {rows.map(item => <li key={item.id}>
        <div>
          <h3>{item.name}</h3>
          <small>{'frequency' in item && item.frequency && <>{frequencyLabels[item.frequency]} · </>}{item.observationDate ? <><time dateTime={item.observationDate}>{item.observationDate}</time> 관측 기준</> : '관측일 미확인'}
            {'stale' in item && item.stale && ' · 오래된 관측값'}
          </small>
        </div>
        <strong className="economic-value" data-state={item.value === null ? 'unpublished' : 'stale' in item && item.stale ? 'stale' : undefined}>{item.value === null
          ? (item.id === 'CPIAUCSL_YOY' && (!('missingReason' in item) || item.missingReason !== 'CURRENT_MISSING')
            ? '전년 동월 관측값 없음' : '미발표 / 관측값 없음') : item.unit === 'index'
          ? `${indexValue.format(item.value)} (1982–84=100)` : `${percent.format(item.value)}%`}</strong>

        {(detailed || 'source' in item) && <dl>
          {'change' in item && item.change != null && item.previousObservationDate && <div>
            <dt>{item.frequency === 'monthly' ? '전월 대비' : '직전 관측 대비'}</dt>
            <dd>{pointChange.format(item.change)}{item.unit === '%' ? '%p' : 'pt'} ({item.previousObservationDate})</dd>
          </div>}
          {'comparisonPeriod' in item && item.comparisonPeriod && <div><dt>전년 동월 기준</dt>
            <dd><time dateTime={item.comparisonPeriod}>{item.comparisonPeriod.slice(0, 7)}</time></dd></div>}
          <div><dt>발표일</dt><dd>{item.releaseDate ?? '미확인'}</dd></div>
        </dl>}
      </li>)}
    </ul>}
    {live && detailed && <div className="indicator-notice">
      <p>공식 발표일 확인에는 원 제공기관의 별도 발표 자료가 필요합니다.</p>
    </div>}
  </section>
}
