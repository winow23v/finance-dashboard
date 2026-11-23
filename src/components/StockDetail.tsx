import { Star } from 'lucide-react'
import { findMarketListing } from '../services/marketListings'
import type { MarketSymbol } from '../types/marketSymbol'
import { UsAnalysis } from './UsAnalysis'
import { KrxAnalysis } from './KrxAnalysis'

export function StockDetail({ listing, saved, onToggle, liveQuote, usQuote, favoriteDisabled }: {
  listing: MarketSymbol; saved: boolean; onToggle: () => void; liveQuote?: boolean; usQuote?: boolean; favoriteDisabled?: boolean
}) {
  const metadata = findMarketListing(listing)
  return <>
    <section className={liveQuote ? "stock-actions" : "panel stock-detail"} aria-label={liveQuote ? "종목 작업" : "종목 정보"}>
      <div className="section-heading">
        <a href={listing.market === 'KR' ? '#domestic' : '#global'}>시장으로 돌아가기</a>
        <button type="button" className="button" aria-pressed={saved} disabled={favoriteDisabled} onClick={onToggle}>
          <Star size={16} aria-hidden="true" /> {saved ? '관심종목 삭제' : '관심종목 추가'}
        </button>
      </div>
      {!liveQuote && <dl className="stock-detail-fields">
        <div><dt>종목 코드</dt><dd>{listing.symbol}</dd></div>
        <div><dt>거래소</dt><dd>{listing.exchange === 'US' ? '미국 · 개별 거래소 미확인' : listing.exchange}</dd></div>
        <div><dt>통화</dt><dd>{usQuote ? 'USD' : metadata?.currency ?? '미확인'}</dd></div>
        {!usQuote && <div><dt>시세 상태</dt><dd>데이터 미연결</dd></div>}
      </dl>}
    </section>
    {liveQuote ? <KrxAnalysis key={listing.symbol} symbol={listing.symbol} /> : usQuote ? <UsAnalysis key={listing.symbol} symbol={listing.symbol} /> : <section className="panel stock-detail" aria-label="기술적 분석">
      <h2>기술적 분석</h2>
      <p className="state" role="status">실제 시가·고가·저가·종가·거래량 데이터가 연결되면 표시됩니다.</p>
    </section>}
  </>
}
