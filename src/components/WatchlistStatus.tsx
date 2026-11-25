import { useCallback, useEffect, useState } from 'react'
import { X } from 'lucide-react'
import type { WatchlistSync } from '../storage/useWatchlist'

const messages = {
  loading: '회원 관심종목을 불러오는 중입니다.',
  saving: '회원 관심종목을 저장하는 중입니다.',
  saved: '회원 관심종목을 저장했습니다.',
  error: '관심종목 동기화에 실패했습니다. 연결을 확인하고 다시 시도해 주세요.',
}

export function ActivityNotice({ message, failed = false, onClose }: { message: string; failed?: boolean; onClose: () => void }) {
  useEffect(() => {
    const timeout = window.setTimeout(onClose, 4000)
    return () => window.clearTimeout(timeout)
  }, [onClose])
  return <div className="notice watchlist-saved data-message" data-state={failed ? 'error' : 'success'}>
    <span role="status">{message}</span>
    <button type="button" className="icon-button" aria-label="알림 닫기" onClick={onClose}><X size={16} aria-hidden="true" /></button>
  </div>
}

export function WatchlistStatus({ sync, email, compact }: { sync: NonNullable<WatchlistSync>; email?: string; compact?: boolean }) {
  const [saved, setSaved] = useState(false)
  const clearSaved = useCallback(() => setSaved(false), [])
  const prompt = !!sync.importable.length && !sync.failure && (sync.status === 'ready' || sync.status === 'saved')
  useEffect(() => { setSaved(sync.status === 'saved') }, [sync.status])
  const status = sync.status === 'ready' || sync.status === 'saved' ? null : messages[sync.status]
  const visible = !!status && !(compact && sync.status === 'loading') || prompt || !!sync.failure || !!sync.unsupported
  return <>
    {sync.status === 'saved' && saved && <ActivityNotice message={messages.saved} onClose={clearSaved} />}
    {!visible && status && <span className="sr-only" role="status">{status}</span>}
    {visible && <div className="notice watchlist-status data-message" data-state={sync.status}>
    {status && <p role="status">{status}</p>}
    {sync.failure && <div className="member-actions">
      <button className="button" onClick={sync.retry}>다시 시도</button>
      {sync.failure !== 'load' && <button className="button" onClick={sync.reload}>서버 목록 다시 불러오기</button>}
    </div>}
    {prompt && <>
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
  </div>}
  </>
}
