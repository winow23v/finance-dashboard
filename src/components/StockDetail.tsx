import { ArrowLeft, RefreshCw, Star } from 'lucide-react'
import { registeredObservation } from '../services/watchlistMetadata'
import type { MarketSymbol } from '../types/marketSymbol'
import { UsAnalysis } from './UsAnalysis'
import { KrxAnalysis } from './KrxAnalysis'

export function StockDetail({ listing, saved, onToggle, liveQuote, usQuote, favoriteDisabled, revision, onRefresh, refreshDisabled }: {
  listing: MarketSymbol; saved: boolean; onToggle: () => void; liveQuote?: boolean; usQuote?: boolean; favoriteDisabled?: boolean
  revision: number; onRefresh: () => void; refreshDisabled: boolean
}) {
  const { name, segment, currency } = registeredObservation(listing)
  const market = listing.market === 'KR' ? '국내시장' : '해외시장'
  const label = name ?? listing.symbol
  const meta = [listing.symbol === label ? null : listing.symbol, listing.market === 'US' ? '미국시장' : '국내시장',
    segment ?? (listing.exchange === 'US' ? '개별 거래소 미확인' : listing.exchange), currency ?? (usQuote ? 'USD' : null)]
    .filter(Boolean).join(' · ')
  const actions = <div className="stock-toolbar" role="group" aria-label="종목 작업">
    <a className="button" href={listing.market === 'KR' ? '#domestic' : '#global'}><ArrowLeft size={16} aria-hidden="true" /> {market}</a>
    <button type="button" className="button stock-favorite" aria-pressed={saved} disabled={favoriteDisabled} onClick={onToggle}>
      <Star size={16} aria-hidden="true" fill={saved ? 'currentColor' : 'none'} /> {saved ? '관심종목 삭제' : '관심종목 추가'}
    </button>
    {(liveQuote || usQuote) && <button type="button" className="button" onClick={onRefresh} disabled={refreshDisabled}>
      <RefreshCw size={16} aria-hidden="true" /> 갱신
    </button>}
  </div>
  if (liveQuote) return <KrxAnalysis key={listing.symbol} symbol={listing.symbol} actions={actions} refresh={revision} />
  if (usQuote) return <UsAnalysis key={listing.symbol} symbol={listing.symbol} stock={{ name: label, meta, actions }} refresh={revision} />
  return <section className="panel stock-detail terminal-detail" aria-label="종목 정보">
    <header className="stock-identity"><h1>{label}</h1><small>{meta}</small>{actions}</header>
    <p className="state" role="status">실제 일봉 데이터가 연결되면 기술적 분석을 표시합니다.</p>
  </section>
}
