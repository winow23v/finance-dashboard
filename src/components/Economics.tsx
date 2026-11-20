import { useEffect, useState } from 'react'
import { Landmark } from 'lucide-react'
import { getEconomyIndicators } from '../services/apiFinanceService'
import type { EconomyIndicators, Indicator } from '../types/finance'

const timestamp = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'short' })
const percent = new Intl.NumberFormat('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const indexValue = new Intl.NumberFormat('ko-KR', { minimumFractionDigits: 3, maximumFractionDigits: 3 })

type EconomyResult =
  | { status: 'loaded'; data: EconomyIndicators | null }
  | { status: 'error' }

export function Economics({ api, demo, detailed, revision }: {
  api: boolean; demo?: Indicator[]; detailed: boolean; revision: number
}) {
  const [attempt, setAttempt] = useState(0)
  const [result, setResult] = useState<{ revision: number; attempt: number; result: EconomyResult }>()
  const current = result?.revision === revision && result.attempt === attempt ? result.result : undefined

  useEffect(() => {
    if (!api) return
    const controller = new AbortController()
    function finish(result: EconomyResult) {
      if (!controller.signal.aborted) setResult({ revision, attempt, result })
    }
    getEconomyIndicators(controller.signal).then(
      data => finish({ status: 'loaded', data }),
      () => finish({ status: 'error' }),
    )
    return () => controller.abort()
  }, [api, revision, attempt])

  const live = current?.status === 'loaded' ? current.data : undefined
  const rows = api ? live?.indicators : demo
  return <section className="panel economy-panel">
    <div className="panel-heading">
      <div><h2><Landmark size={17} aria-hidden="true" /> 주요 경제지표</h2><p>미국 거시경제 지표</p></div>
      {(!api || live) && <span className="badge">{api ? 'FRED · 실데이터' : 'DEMO · 샘플 데이터'}</span>}
    </div>
    {api && !current && <p className="state" role="status">경제지표를 불러오는 중입니다.</p>}
    {api && current?.status === 'error' && <div className="state">
      <p role="alert">경제지표를 불러오지 못했습니다.</p>
      <button className="button" onClick={() => setAttempt(value => value + 1)}>다시 시도</button>
    </div>}
    {api && live === null && <p className="state" role="status">FRED 실데이터 연동이 꺼져 있습니다.</p>}
    {!api && !rows?.length && <p className="state">표시할 경제지표가 없습니다.</p>}
    {!!rows?.length && <ul className={detailed ? 'indicator-list indicator-detail' : 'indicator-list'}>
      {rows.map(item => <li key={item.id}>
        <div>
          <h3>{item.name}</h3>
          <small>{item.observationDate ? <><time dateTime={item.observationDate}>{item.observationDate}</time> 관측 기준</> : '관측일 미확인'}
            {'stale' in item && item.stale && ' · 오래된 관측값'}
          </small>
        </div>
        <strong>{item.value === null ? '미발표 / 관측값 없음' : item.unit === 'index'
          ? `${indexValue.format(item.value)} (1982–84=100)` : `${percent.format(item.value)}%`}</strong>
        {'source' in item && <div className="indicator-source"><small>
          출처 <a href={item.source.url}>FRED · {item.source.agency}</a>
        </small></div>}
        {detailed && <dl>
          <div><dt>발표일</dt><dd>{item.releaseDate ?? '미확인'}</dd></div>
          <div><dt>수집 시각 (KST)</dt><dd><time dateTime={item.collectedAt}>{timestamp.format(new Date(item.collectedAt))}</time></dd></div>
        </dl>}
      </li>)}
    </ul>}
    {live && <div className="indicator-notice">
      {detailed && <p>공식 발표일 확인에는 원 제공기관의 별도 발표 자료가 필요합니다.</p>}
      <p lang="en">This product uses the FRED® API but is not endorsed or certified by the Federal Reserve Bank of St. Louis.</p>
      <p>FRED 연동 기능을 이용하면 <a href="https://fred.stlouisfed.org/docs/api/terms_of_use.html">FRED API 이용약관</a>의 적용에 동의하게 됩니다.</p>
    </div>}
  </section>
}
