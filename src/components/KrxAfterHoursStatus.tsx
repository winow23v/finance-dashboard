import type { KrxAfterHours, KrxReason } from '../types/finance'
import { krxStateLabels } from './KrxStocks'

const time = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'short',
})
export function formatKrxCollectionTime(value: string) {
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? time.format(timestamp) + ' (KST)' : '시각 확인 불가'
}

export function regularQuoteStatus(reason: string) {
  return Object.hasOwn(krxStateLabels, reason) ? krxStateLabels[reason as KrxReason] : '공표 상태 확인 필요'
}

export function KrxAfterHoursStatus({ details, compact = false }: { details?: KrxAfterHours[]; compact?: boolean }) {
  if (!details?.length) return compact ? null : <p className="heatmap-meta">시간외 가격 · 공급 상태 미확인</p>
  const state = (entry: KrxAfterHours) => entry.status === 'market-closed' ? '휴장' : entry.status === 'calendar-unavailable' ? '거래 일정 미확인' : '가격 공급 미연결'
  if (compact) return <small className="watchlist-quote">시간외 · {details.map(entry => entry.venue + ' ' + state(entry)).join(' · ')}</small>
  return <details className="technical-detail-group">
    <summary>시간외 가격 · {details.map(entry => entry.venue + ' ' + state(entry)).join(' · ')}</summary>
    <dl className="stock-detail-fields">
      {details.map(entry => <div key={entry.venue}>
        <dt>{entry.venue}</dt><dd>{state(entry)}<small>{entry.tradingDate} · 거래 대상 종목 여부 미확인</small>
          {entry.status === 'provider-unavailable' && <small>{entry.connectionCheckedAt
            ? '공급 연결 점검 ' + formatKrxCollectionTime(entry.connectionCheckedAt)
            : '공급 연결 점검 예정 ' + formatKrxCollectionTime(entry.scheduledCheckAt)}</small>}
        </dd>
      </div>)}
    </dl>
  </details>
}
