import { useSyncExternalStore } from 'react'
import { providerStatuses } from '../services/providerStatus'

const labels = {
  published: '실제 공표 자료', previous: '이전 공표 기준환율', restricted: '공급자 접근 제한',
  error: '조회 실패', unavailable: '공표값 없음', partial: '일부 자료 조회 불가',
}

export function DataStatus({ api }: { api: boolean }) {
  const statuses = useSyncExternalStore(providerStatuses.subscribe, providerStatuses.read)
  return <div className="data-status">
    <h3>데이터 연결</h3>
    <dl>
      <div><dt>시장 지수</dt><dd>데이터 미연결</dd></div>
      <div><dt>개별 주식·ETF</dt><dd>데이터 미연결</dd></div>
      {api && <>
        <div><dt>한국은행 ECOS</dt><dd>{statuses.ecos ? labels[statuses.ecos] : '경제지표 탭에서 확인'}</dd></div>
        <div><dt>Frankfurter · ECB</dt><dd>{statuses.fx ? statuses.fx === 'published' ? '실제 공표 기준환율' : labels[statuses.fx] : '개요 탭에서 확인'}</dd></div>
        <div><dt>OPEN DART</dt><dd>{statuses.dart ? labels[statuses.dart] : '기업 선택 또는 검색 시 확인'}</dd></div>
        <div><dt>SEC EDGAR</dt><dd>{statuses.sec ? labels[statuses.sec] : '기업 선택 또는 검색 시 확인'}</dd></div>
        <div><dt>FRED</dt><dd>비공개 · 공개 화면의 실데이터 제공 꺼짐</dd></div>
      </>}
    </dl>
  </div>
}
