import { useRef, useState } from 'react'
import { Plus, Search, Star, X } from 'lucide-react'
import { Change, price } from './QuoteDisplay'
import { marketSymbolKey, type EquityMarket, type MarketSymbol } from '../types/marketSymbol'
import type { EquityQuote } from '../types/finance'
import type { SettingsState } from '../storage/guestStorage'

type Row = { listing: MarketSymbol; quote?: EquityQuote }
type Props = {
  stocks: EquityQuote[]
  selected: MarketSymbol[]
  onToggle: (symbol: MarketSymbol) => void
  units: SettingsState['units']
  market?: EquityMarket
  catalogUnavailable: boolean
  simulated: boolean
}

function FavoriteButton({ name, active, onClick }: { name: string; active: boolean; onClick: () => void }) {
  return <button type="button" className="favorite-button" aria-pressed={active}
    aria-label={name + ' 관심종목'} title={active ? '관심종목에서 삭제' : '관심종목에 추가'} onClick={onClick}>
    <Star size={19} fill={active ? 'currentColor' : 'none'} aria-hidden="true" />
  </button>
}

function StockTable({ rows, saved, onToggle, units, label, simulated }: {
  rows: Row[]; saved: Set<string>; onToggle: Props['onToggle']; units: Props['units']; label: string; simulated: boolean
}) {
  return <table className="watch-table" aria-label={label}>
    <thead><tr><th scope="col">종목</th><th scope="col">{simulated ? '샘플 가격' : '가격'}</th><th scope="col">등락률</th><th scope="col" className="star-col"><span className="sr-only">관심종목</span></th></tr></thead>
    <tbody>{rows.map(({ listing, quote }) => {
      const key = marketSymbolKey(listing)
      const name = quote?.name ?? listing.symbol
      return <tr key={key}>
        <th scope="row"><span className="stock-name" title={name}>{name}</span><small className="stock-name">{listing.symbol} · {listing.exchange}{quote?.kind === 'etf' && ' · ETF'}</small></th>
        <td>{quote ? <>{price(quote, units)}<small>{quote.currency}</small></> : <span aria-label="가격 데이터 없음">—</span>}</td>
        <td>{quote ? <Change quote={quote} /> : <span aria-label="등락률 데이터 없음">—</span>}</td>
        <td className="star-col"><FavoriteButton name={name} active={saved.has(key)} onClick={() => onToggle(listing)} /></td>
      </tr>
    })}</tbody>
  </table>
}

export function Watchlist({ stocks, selected, onToggle, units, market, catalogUnavailable, simulated }: Props) {
  const [query, setQuery] = useState('')
  const editor = useRef<HTMLDialogElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const scope = stocks.filter(quote => !market || quote.market === market)
  const quotes = new Map(scope.map(quote => [marketSymbolKey(quote), quote]))
  const saved = new Set(selected.map(marketSymbolKey))
  const rows = selected.filter(listing => !market || listing.market === market)
    .map(listing => ({ listing, quote: quotes.get(marketSymbolKey(listing)) }))
  const catalog = Array.from(quotes.values(), quote => ({ listing: quote, quote }))
  const matches = catalog.filter(({ quote }) => [quote.name, quote.symbol, quote.exchange, quote.kind]
    .join(' ').toLowerCase().includes(query.trim().toLowerCase()))
  const title = market === 'KR' ? '국내 관심종목' : market === 'US' ? '해외 관심종목' : '관심종목'
  const openEditor = () => {
    setQuery('')
    editor.current?.showModal()
    input.current?.focus()
  }
  const unavailable = '현재 API는 개별 주식·ETF 시세를 제공하지 않습니다.'
  const tableProps = { saved, onToggle, units, simulated }

  return <div className="watch-sections">
    <section className="panel watch-panel">
      <div className="panel-heading">
        <div><h2><Star size={17} aria-hidden="true" /> {title}</h2><p>{rows.length}개 종목</p></div>
        <button type="button" className="button" onClick={openEditor}><Plus size={16} aria-hidden="true" /> {rows.length ? '종목 편집' : '종목 추가'}</button>
      </div>
      {rows.length ? <StockTable rows={rows} label={title} {...tableProps} /> :
        <p className="state">{catalogUnavailable ? '등록된 관심종목이 없습니다.' : '등록된 관심종목이 없습니다. 별표를 눌러 추가할 수 있습니다.'}</p>}
    </section>
    {market && <section className="panel catalog-panel">
      <div className="panel-heading"><h2>{market === 'KR' ? '국내' : '해외'} 주식 · ETF</h2></div>
      {catalog.length ? <StockTable rows={catalog} label="주식 및 ETF 목록" {...tableProps} /> :
        <p className="state">{catalogUnavailable ? unavailable : '표시할 종목이 없습니다.'}</p>}
    </section>}
    <dialog ref={editor} aria-label="관심종목 편집">
      <div className="panel-heading"><h2>관심종목 편집</h2><button type="button" className="icon-button" aria-label="닫기" onClick={() => editor.current?.close()}><X size={20} /></button></div>
      <label className="search"><Search size={18} aria-hidden="true" /><input ref={input} value={query} onChange={event => setQuery(event.target.value)} placeholder="종목명 또는 티커 검색" aria-label="종목명 또는 티커 검색" /></label>
      {matches.length ? <StockTable rows={matches} label="관심종목 검색 결과" {...tableProps} /> :
        <p className="state" role="status">{catalogUnavailable ? unavailable : '검색 결과가 없습니다.'}</p>}
    </dialog>
  </div>
}
