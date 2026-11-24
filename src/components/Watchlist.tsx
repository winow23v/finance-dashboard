import { useEffect, useId, useRef, useState } from 'react'
import { Plus, Search, Star, X } from 'lucide-react'
import { marketSymbolKey, type EquityMarket, type MarketSymbol } from '../types/marketSymbol'
import { marketListings, stockHref } from '../services/marketListings'
import { favoriteKey, isWatchlistSymbol } from '../services/watchlist'
import { KrxAfterHoursStatus, regularQuoteStatus, formatKrxCollectionTime } from './KrxAfterHoursStatus'
import { getKrxStocks } from '../services/apiFinanceService'
import { krxObservation, registeredObservation, watchlistObservations, type Observation } from '../services/watchlistMetadata'

type Props = {
  selected: MarketSymbol[]; onToggle: (symbol: MarketSymbol) => void; market?: EquityMarket
  blocked?: boolean; loading?: boolean; live?: boolean; summary?: boolean
}

type Row = { listing: MarketSymbol; observation?: Observation }
const number = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 2 })
const percent = new Intl.NumberFormat('ko-KR', { signDisplay: 'exceptZero', maximumFractionDigits: 2 })

function StockList({ rows, saved, onToggle, label, blocked }: {
  rows: Row[]; saved: Set<string>; onToggle: Props['onToggle']; label: string; blocked?: boolean
}) {
  return <ul className="stock-list" aria-label={label}>
    {rows.map(({ listing, observation }) => {
      const { name, segment, currency, quote, regular, afterHours } = { ...registeredObservation(listing), ...observation }
      const active = saved.has(favoriteKey(listing))
      const venue = segment ?? (listing.exchange === 'US' ? '거래소 미확인' : listing.exchange)
      return <li key={marketSymbolKey(listing)}>
        <div>
          <a className="stock-detail-link" href={stockHref(listing)}>{name ?? '종목명 미확인'}</a>
          <small>{listing.symbol} · {listing.market === 'KR' ? '국내' : '미국'} · {venue} · {currency ?? '통화 미확인'}</small>
          {quote && <small className="watchlist-quote">
            {listing.market === 'KR' && '정규장 종가 '}{number.format(quote.price)} {currency}
            {quote.changePercent !== null && ' · ' + percent.format(quote.changePercent) + '%'}
            {' · ' + quote.tradingDate + ' 기준'}
          </small>}
          {regular && <small className="watchlist-quote">{regular.source}
            {regular.usingPreviousClose && ' · 이전 정상 종가 사용'}
            {regular.collectedAt && ' · 마지막 정상 수집 ' + formatKrxCollectionTime(regular.collectedAt)}
            {regular.lastAttemptAt && ' · 마지막 시도 ' + formatKrxCollectionTime(regular.lastAttemptAt)}
            {regular.reason && ' · ' + regularQuoteStatus(regular.reason)}
          </small>}
          {afterHours && <KrxAfterHoursStatus details={afterHours} compact />}
        </div>
        <button type="button" className="favorite-button" disabled={blocked} aria-pressed={active}
          aria-label={(name ?? listing.symbol) + (active ? ' 관심종목에서 삭제' : ' 관심종목에 추가')}
          onClick={() => onToggle(listing)}><Star size={19} fill={active ? 'currentColor' : 'none'} aria-hidden="true" /></button>
      </li>
    })}
  </ul>
}

export function Watchlist({ selected, onToggle, market, blocked, loading, live, summary }: Props) {
  const [query, setQuery] = useState('')
  const [observations, setObservations] = useState(new Map<string, Observation>())
  const [search, setSearch] = useState<{ query: string; rows: Row[]; failed: boolean }>()
  const titleId = useId()
  const inputId = useId()
  const editor = useRef<HTMLDialogElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const saved = new Set(selected.map(favoriteKey))
  const inMarket = (listing: MarketSymbol) => !market || market === listing.market
  const marketRows = selected.filter(inMarket)
  const rows = summary ? marketRows.slice(0, 3) : marketRows
  const term = query.trim().slice(0, 64)
  const domesticSearch = live && market !== 'US' && term.length > 0
  const searchResult = domesticSearch && search?.query === term ? search : undefined

  useEffect(() => {
    if (!live) return
    const visible = selected.filter(item => !market || item.market === market)
    const items = (summary ? visible.slice(0, 3) : visible).filter(isWatchlistSymbol)
    if (!items.length) return
    const controller = new AbortController()
    async function load() {
      for (let start = 0; start < items.length && !controller.signal.aborted; start += 20) {
        try {
          const entries = await watchlistObservations(items.slice(start, start + 20), controller.signal)
          if (!controller.signal.aborted) setObservations(previous => new Map([...previous, ...entries]))
        } catch {
          break
        }
      }
    }
    void load()
    return () => controller.abort()
  }, [selected, live, market, summary])

  useEffect(() => {
    if (!domesticSearch) return
    const controller = new AbortController()
    const timer = window.setTimeout(async () => {
      const filters = /^(?=[0-9A-Z]*[0-9])[0-9A-Z]{6}$/i.test(term) ? { symbol: term.toUpperCase() } : { q: term }
      const results = await Promise.allSettled((['KOSPI', 'KOSDAQ'] as const).map(segment => getKrxStocks(segment, filters, controller.signal)))
      if (controller.signal.aborted) return
      const items = results.flatMap(result => result.status === 'fulfilled' ? result.value.items : [])
        .filter(item => !filters.symbol || item.symbol === filters.symbol)
      const counts = new Map<string, number>()
      for (const item of items) counts.set(item.symbol, (counts.get(item.symbol) ?? 0) + 1)
      setSearch({
        query: term,
        rows: items.filter(item => counts.get(item.symbol) === 1).map(item => ({
          listing: { market: 'KR', exchange: 'XKRX', symbol: item.symbol }, observation: krxObservation(item),
        })),
        failed: results.some(result => result.status === 'rejected' || result.value.listings.status === 'unavailable'),
      })
    }, 350)
    return () => { window.clearTimeout(timer); controller.abort() }
  }, [domesticSearch, term])

  const words = term.toLocaleLowerCase('ko-KR').split(/\s+/).filter(Boolean)
  const matches = marketListings.filter(({ listing, name, currency }) => {
    const fields = [name, listing.symbol, listing.exchange, currency].join(' ').toLocaleLowerCase('ko-KR')
    return inMarket(listing) && words.every(word => fields.includes(word))
  })
  const results = new Map<string, Row>(matches.map(({ listing }) => [favoriteKey(listing), { listing }]))
  for (const row of searchResult?.rows ?? []) results.set(favoriteKey(row.listing), row)
  const ticker = term.toUpperCase().replace('.', '-')
  const candidate: MarketSymbol = { market: 'US', exchange: 'US', symbol: ticker }
  if (market !== 'KR' && isWatchlistSymbol(candidate) && !results.has(favoriteKey(candidate))
    && !marketListings.some(({ listing }) => favoriteKey(listing) === favoriteKey(candidate))) {
    results.set(favoriteKey(candidate), { listing: candidate })
  }
  const title = market === 'KR' ? '국내 관심종목' : market === 'US' ? '해외 관심종목' : '관심종목'

  return <section className={summary ? 'panel watch-panel overview-watch' : 'panel watch-panel'}>
    <div className="panel-heading">
      <div><h2><Star size={17} aria-hidden="true" /> {title}</h2>{!loading && <p>{marketRows.length}개 종목</p>}</div>
      <button type="button" className="button" onClick={() => {
        setQuery('')
        editor.current?.showModal()
        input.current?.focus()
      }}><Plus size={16} aria-hidden="true" /> 종목 검색</button>
    </div>
    {rows.length ? <StockList rows={rows.map(listing => ({ listing, observation: observations.get(marketSymbolKey(listing)) }))}
      saved={saved} onToggle={onToggle} label={title} blocked={blocked} />
      : !loading && <p className="state">등록된 관심종목이 없습니다.</p>}
    {summary && <a className="text-link overview-watch-link" href="#watchlist">관심종목 전체 보기</a>}
    <dialog className="stock-search-dialog" ref={editor} aria-labelledby={titleId} onClose={() => setQuery('')} onClick={event => {
      if (event.target instanceof Element && event.target.closest('a')) editor.current?.close()
    }}>
      <div className="panel-heading"><h2 id={titleId}>종목 검색</h2><button type="button" className="icon-button" aria-label="닫기"
        onClick={() => editor.current?.close()}><X size={20} /></button></div>
      <label className="sr-only" htmlFor={inputId}>기업명 또는 종목 코드</label>
      <div className="search">
        <Search size={18} aria-hidden="true" />
        <input id={inputId} ref={input} type="search" value={query} maxLength={64} onChange={event => setQuery(event.target.value)}
          placeholder={market === 'US' ? '예: Apple 또는 AAPL' : '기업명 또는 종목 코드'} />
        {query && <button type="button" className="icon-button search-clear" aria-label="검색어 초기화" onClick={() => {
          setQuery('')
          input.current?.focus()
        }}><X size={18} aria-hidden="true" /></button>}
      </div>
      {domesticSearch && !searchResult && <p className="state" role="status">KRX 종목 검색 중입니다.</p>}
      {searchResult?.failed && <p className="state" role="status">일부 KRX 종목 정보를 확인할 수 없습니다.</p>}
      {results.size > 0 ? <StockList rows={[...results.values()]} saved={saved} onToggle={onToggle} label="종목 검색 결과" blocked={blocked} />
        : (!domesticSearch || searchResult) && <p className="state" role="status">검색 결과가 없습니다.</p>}
    </dialog>
  </section>
}
