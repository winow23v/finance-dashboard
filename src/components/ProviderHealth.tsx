import { isRecord } from '../services/apiFinanceService'
import { usePublicData } from '../services/usePublicData'

const names: Record<string, string> = {
  krx: 'KRX OPEN API', fx: 'Frankfurter', ecos: '한국은행 ECOS', dart: 'OPEN DART',
  yfinance: 'yfinance', 'kr-intraday': '국내 장중 시세',
}
const statuses = new Set(['Healthy', 'Degraded', 'Stale', 'Unavailable', 'Rate Limited', 'Not Configured'])
const time = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'short' })
const formatTime = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? time.format(new Date(value)) : '—'
const field = (value: unknown) => typeof value === 'string' || typeof value === 'number' ? value : '—'

function parse(value: unknown) {
  if (!isRecord(value) || !Array.isArray(value.providers)) throw new Error('Invalid provider health')
  return value.providers.filter((row): row is Record<string, unknown> & { provider: string; status: string } =>
    isRecord(row) && typeof row.provider === 'string' && Object.hasOwn(names, row.provider) &&
    typeof row.status === 'string' && statuses.has(row.status))
}

export function ProviderHealth({ revision }: { revision: number }) {
  const result = usePublicData('/api/v1/admin/providers', revision, parse, 10_000)
  return <details className="technical-detail-group">
    <summary>데이터 공급자 운영 상태</summary>
    {result?.data ? <ul className="member-list">{result.data.map(row => <li key={row.provider}>
      <strong>{names[row.provider]} · {row.status}</strong>
      <dl className="stock-detail-fields">
        <div><dt>정상 수집 (KST)</dt><dd>{formatTime(row.succeededAt)}</dd></div>
        <div><dt>마지막 시도 (KST)</dt><dd>{formatTime(row.attemptedAt)}</dd></div>
        <div><dt>데이터 기준일</dt><dd>{field(row.observationDate)}</dd></div>
        <div><dt>응답 시간 (ms)</dt><dd>{field(row.responseMs)}</dd></div>
        <div><dt>최근 오류 · HTTP</dt><dd>{field(row.errorCode)} · {field(row.httpStatus)}</dd></div>
        <div><dt>재시도 · 연속 실패</dt><dd>{field(row.retries)} · {field(row.consecutiveFailures)}</dd></div>
      </dl>
    </li>)}</ul> : <p role="status">{result ? '공급자 상태를 조회하지 못했습니다.' : '공급자 상태를 불러오는 중입니다.'}</p>}
  </details>
}
