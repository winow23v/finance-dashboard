import type { WatchlistSync } from '../storage/useWatchlist'

const messages = {
  loading: '회원 관심종목을 불러오는 중입니다.',
  ready: '회원 관심종목을 불러왔습니다.',
  saving: '회원 관심종목을 저장하는 중입니다.',
  saved: '회원 관심종목을 저장했습니다.',
  error: '관심종목 동기화에 실패했습니다. 연결을 확인하고 다시 시도해 주세요.',
}

export function WatchlistStatus({ sync, email }: { sync: NonNullable<WatchlistSync>; email?: string }) {
  return <div className="notice watchlist-status">
    <p role="status">{messages[sync.status]}</p>
    {sync.failure && <div className="member-actions">
      <button className="button" onClick={sync.retry}>다시 시도</button>
      {sync.failure !== 'load' && <button className="button" onClick={sync.reload}>서버 목록 다시 불러오기</button>}
    </div>}
    {!!sync.importable.length && !sync.failure && (sync.status === 'ready' || sync.status === 'saved') && <>
      <p>이 브라우저에만 저장된 종목 {sync.importable.length}개를 {email} 계정으로 가져올 수 있습니다.</p>
      <ul className="watchlist-import-items">
        {sync.importable.map(item => <li key={JSON.stringify(item)}>{item.symbol} · {item.exchange}</li>)}
      </ul>
      <div className="member-actions">
        <button className="button" onClick={sync.importLocal}>누락 종목 가져오기</button>
        <button className="button" onClick={sync.dismiss}>이 계정에 가져오지 않기</button>
      </div>
    </>}
    {!!sync.unsupported && <p>지원하는 종목 식별자와 일치하지 않는 {sync.unsupported}개 항목은 이 브라우저에 보존됩니다.</p>}
  </div>
}
