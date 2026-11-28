import type { MarketCheck } from '../services/useMarketEntry'
import { useSyncExternalStore } from 'react'
import type { KrxOverview, MarketIndex } from '../types/finance'
import { providerStatuses } from '../services/providerStatus'

const labels = {
  published: '실제 공표 자료', previous: '이전 공표 기준환율',
  error: '조회 실패', unavailable: '공표값 없음', partial: '일부 자료 조회 불가',
}

const checks = {
  checking: '확인 중',
  partial: '일부 자료 미확인',
  failed: '조회 실패',
  retained: '갱신 실패 · 이전 유효값 표시',
} as const

export function DataStatus({ api, indices, indexCheck, krx, krxCheck }: {
  api: boolean; indices?: MarketIndex[] | null; indexCheck?: MarketCheck; krx?: KrxOverview | null; krxCheck?: MarketCheck
}) {
  const statuses = useSyncExternalStore(providerStatuses.subscribe, providerStatuses.read)
  const indexStatus = indexCheck && indexCheck !== 'confirmed' ? checks[indexCheck] : indices === null ? '조회 실패' : !indices?.length ? '확인되지 않음'
    : indices.every(index => index.status === 'available') ? '공표값 확인'
      : indices.some(index => index.status !== 'unavailable') ? '이전 수집값 또는 일부 자료 미확인' : '유효한 관측값 미확인'
  const heatmapStatus = krxCheck && krxCheck !== 'confirmed' ? checks[krxCheck] : krx === null ? '조회 실패' : !krx ? '확인되지 않음'
    : krx.tiles.length ? '종가·시가총액 확인' : '표시 가능한 자료 없음'
  return <div className="data-status">
    <h3>데이터 연결</h3>
    <dl>
      <div><dt>시장 지수</dt><dd>{api ? indexStatus : '데이터 미연결'}</dd></div>
      <div><dt>개별 주식·ETF</dt><dd>{api ? '종목 상세에서 확인' : '데이터 미연결'}</dd></div>
      <div><dt>국내 시장 히트맵</dt><dd>{api ? heatmapStatus : '데이터 미연결'}</dd></div>
      {api && <>
        <div><dt>한국은행 ECOS</dt><dd>{statuses.ecos ? labels[statuses.ecos] : '확인되지 않음'}</dd></div>
        <div><dt>Frankfurter · ECB</dt><dd>{statuses.fx ? statuses.fx === 'published' ? '실제 공표 기준환율' : labels[statuses.fx] : '확인되지 않음'}</dd></div>
        <div><dt>OPEN DART</dt><dd>{statuses.dart ? labels[statuses.dart] : '확인되지 않음'}</dd></div>
        <div><dt>FRED</dt><dd>{statuses.fred ? (statuses.fred === 'unavailable' ? '제공 꺼짐 또는 관측값 없음' : labels[statuses.fred]) : '확인되지 않음'}</dd></div>
      </>}
    </dl>
  </div>
}
