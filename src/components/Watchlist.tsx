import { useId, useRef, useState } from 'react'
import { Plus, Search, Star, X } from 'lucide-react'
import { marketSymbolKey, type EquityMarket, type MarketSymbol } from '../types/marketSymbol'
import { findMarketListing, marketListings, stockHref } from '../services/marketListings'

type Props = { selected: MarketSymbol[]; onToggle: (symbol: MarketSymbol) => void; market?: EquityMarket }

function StockList({ listings, saved, onToggle, label }: {
  listings: MarketSymbol[]; saved: Set<string>; onToggle: Props['onToggle']; label: string
}) {
  return <ul className="stock-list" aria-label={label}>
    {listings.map(listing => {
      const key = marketSymbolKey(listing)
      const metadata = findMarketListing(listing)
      const name = metadata?.name ?? listing.symbol
      const active = saved.has(key)
      return <li key={key}>
        <div>
          <a className="stock-detail-link" href={stockHref(listing)}>{name}</a>
          <small>{listing.symbol} · {listing.market === 'KR' ? '국내' : '미국'} · {listing.exchange} · {metadata?.currency ?? '통화 미확인'}</small>
        </div>
        <button type="button" className="favorite-button" aria-pressed={active}
          aria-label={name + ' 관심종목'} title={active ? '관심종목에서 삭제' : '관심종목에 추가'}
          onClick={() => onToggle(listing)}><Star size={19} fill={active ? 'currentColor' : 'none'} aria-hidden="true" /></button>
      </li>
    })}
  </ul>
}

export function Watchlist({ selected, onToggle, market }: Props) {
  const [query, setQuery] = useState('')
  const titleId = useId()
  const inputId = useId()
  const editor = useRef<HTMLDialogElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const saved = new Set(selected.map(marketSymbolKey))
  const inMarket = (listing: MarketSymbol) => !market || market === listing.market
  const rows = selected.filter(inMarket)
  const words = query.trim().toLocaleLowerCase('ko-KR').split(/\s+/).filter(Boolean)
  const matches = marketListings.filter(({ listing, name, currency }) => {
    const fields = [name, listing.symbol, listing.exchange, currency].join(' ').toLocaleLowerCase('ko-KR')
    return inMarket(listing) && words.every(word => fields.includes(word))
  })
  const ticker = query.trim().toUpperCase().replace('.', '-')
  const tickerMatch = /^[A-Z][A-Z0-9]{0,9}(-[A-Z0-9]{1,5})?$/.test(ticker)
    && !matches.some(({ listing }) => listing.market === 'US' && listing.symbol === ticker)
  const title = market === 'KR' ? '국내 관심종목' : market === 'US' ? '해외 관심종목' : '관심종목'

  return <section className="panel watch-panel">
    <div className="panel-heading">
      <div><h2><Star size={17} aria-hidden="true" /> {title}</h2><p>{rows.length}개 종목</p></div>
      <button type="button" className="button" onClick={() => {
        setQuery('')
        editor.current?.showModal()
        input.current?.focus()
      }}><Plus size={16} aria-hidden="true" /> 종목 검색</button>
    </div>
    {rows.length ? <StockList listings={rows} saved={saved} onToggle={onToggle} label={title} />
      : <p className="state">등록된 관심종목이 없습니다.</p>}
    <dialog className="stock-search-dialog" ref={editor} aria-labelledby={titleId} onClick={event => {
      if (event.target instanceof Element && event.target.closest("a")) editor.current?.close()
    }}>
      <div className="panel-heading"><h2 id={titleId}>종목 검색</h2><button type="button" className="icon-button" aria-label="닫기"
        onClick={() => editor.current?.close()}><X size={20} /></button></div>
      <p className="search-scope">{market === 'KR' ? '국내 등록 종목' : market === 'US'
        ? '미국 등록 종목 또는 티커 직접 입력' : '국내·미국 등록 종목'}</p>
      <label className="sr-only" htmlFor={inputId}>기업명 또는 종목 코드</label>
      <div className="search">
        <Search size={18} aria-hidden="true" />
        <input id={inputId} ref={input} type="search" value={query} onChange={event => setQuery(event.target.value)}
          placeholder={market === 'US' ? '예: Apple 또는 AAPL' : '기업명 또는 종목 코드'} />
        {query && <button type="button" className="icon-button search-clear" aria-label="검색어 초기화" onClick={() => {
          setQuery('')
          input.current?.focus()
        }}><X size={18} aria-hidden="true" /></button>}
      </div>
      {market === 'US' && tickerMatch &&
        <StockList listings={[{ market: 'US', exchange: 'US', symbol: ticker }]} saved={saved} onToggle={onToggle} label="미국 티커 조회" />}
      {matches.length ? <StockList listings={matches.map(item => item.listing)} saved={saved} onToggle={onToggle} label="종목 검색 결과" />
        : !(market === 'US' && tickerMatch) && <p className="state" role="status">검색 결과가 없습니다. 검색어를 지우고 다시 검색할 수 있습니다.</p>}
    </dialog>
  </section>
}
