import { ClientPages } from './ClientPages'
import { formatWon } from '../services/formatWon'
import { SearchButton, useSearchComposition } from './SearchButton'
import { LoadingSkeleton } from "./LoadingSkeleton"
import { useEffect, useState } from 'react'
import { Search, SlidersHorizontal, Star, X } from 'lucide-react'
import { getKrxStocks, marketRequestMessage } from '../services/apiFinanceService'
import { stockHref } from '../services/marketListings'
import type { KrxMarket, KrxReason, KrxStocks as StockResults } from '../types/finance'
import { marketSymbolKey, type MarketSymbol } from '../types/marketSymbol'
import { Change } from './QuoteDisplay'

const number = new Intl.NumberFormat('ko-KR')

export const krxStateLabels: Record<KrxReason, string> = {
  'provider-not-configured': 'KRX 공급자 미연결',
  'provider-error': 'KRX 조회 실패',
  'not-published': '기준 거래일 확정 종가 미확인',
  weekend: '거래소 휴장',
  'before-collection': '종가 미확인',
}

export function KrxStocks({ selected, onToggle, symbol, blocked }: {
  selected: MarketSymbol[]
  blocked?: boolean
  onToggle: (listing: MarketSymbol) => void
  symbol?: string
}) {
  const { composing, inputEvents } = useSearchComposition()
  const [market, setMarket] = useState<KrxMarket>('KOSPI')
  const [input, setInput] = useState('')
  const [query, setQuery] = useState('')
  const [revision, setRevision] = useState(0)
  const [result, setResult] = useState<{ market: KrxMarket; symbol?: string; query: string; revision: number; data: StockResults[] | null; message?: string }>()
  const current = result?.market === market && result.symbol === symbol && result.query === query && result.revision === revision ? result : undefined

  useEffect(() => {
    if (!symbol && !query) return
    const controller = new AbortController()
    const markets: KrxMarket[] = symbol ? ['KOSPI', 'KOSDAQ'] : [market]
    const filters = symbol ? { symbol } : query ? { q: query } : {}
    void Promise.allSettled(markets.map(value => getKrxStocks(value, filters, controller.signal))).then(outcomes => {
      if (controller.signal.aborted) return
      const data = outcomes.flatMap(outcome => outcome.status === 'fulfilled' ? [outcome.value] : [])
      const failure = outcomes.find(outcome => outcome.status === 'rejected')
      const listingUnavailable = data.some(dataset => dataset.listings.status === 'unavailable')
      const message = failure ? marketRequestMessage(failure.reason, data.length ? '일부 시장의 종목 조회 실패' : '국내 종목 조회 실패')
        : listingUnavailable ? 'KRX 종목 목록 조회 불가' : undefined
      setResult(previous => {
        const sameLookup = previous?.market === market && previous.symbol === symbol && previous.query === query
        const previousData = sameLookup ? previous.data ?? [] : []
        const visible = outcomes.flatMap((outcome, index) => {
          const prior = previousData.find(dataset => dataset.market === markets[index])
          if (outcome.status === 'rejected') return prior ? [prior] : []
          if (outcome.value.listings.status !== 'unavailable' || !prior || !prior.items.length) return [outcome.value]
          const items = new Map(prior.items.map(item => [item.symbol, item]))
          for (const item of outcome.value.items) items.set(item.symbol, item)
          return [{ ...outcome.value, items: [...items.values()] }]
        })
        return { market, symbol, query, revision, data: visible.length ? visible : null, message }
      })
    })
    return () => controller.abort()
  }, [market, query, revision, symbol])

  const pending = !!(symbol || query) && !current
  const retained = pending && result?.data && result.market === market && result.symbol === symbol && result.query === query ? result : current

  return <section aria-busy={pending} className="panel watch-panel krx-stock-search" aria-label="국내 종목 시세">
    <div className="panel-heading"><h2><Search size={18} aria-hidden="true" /> 국내 종목 시세</h2></div>
    {!symbol && <form className="disclosure-controls terminal-filters krx-search-controls quote-search-controls" onSubmit={event => {
      event.preventDefault()
      if (composing.current || !input.trim() || (input.trim() === query && (pending || !current?.message && current?.data !== null))) return
      setQuery(input.trim())
      setRevision(value => value + 1)
    }}>
      <label><span><SlidersHorizontal size={14} aria-hidden="true" /> 시장</span><select value={market} onChange={event => setMarket(event.target.value as KrxMarket)}>
        <option>KOSPI</option><option>KOSDAQ</option>
      </select></label>
      <label>종목명 또는 단축코드 <input {...inputEvents} type="search" placeholder="예: 삼성전자 또는 005930" value={input} maxLength={64} onChange={event => setInput(event.target.value)} /></label>
      <SearchButton pending={pending} disabled={!input.trim() || pending && input.trim() === query} />
      {(input || query) && <button type="button" className="button" onClick={() => {
        setInput('')
        setQuery('')
        setMarket('KOSPI')
      }}><X size={16} aria-hidden="true" /> 초기화</button>}
    </form>}
    {!symbol && !query ? <p className="state">KOSPI 또는 KOSDAQ을 선택하고 종목명이나 코드를 입력하세요.</p> : !retained ? <LoadingSkeleton message="국내 종목을 불러오는 중입니다." shape="rows" /> : retained.data === null
      ? <p className="state" role="status">{retained.message}</p>
      : <>
        {!pending && retained.message && <p className="state" role="status">{retained.message}</p>}
        {retained.data.map(dataset => {
        const details = [...new Set([dataset.listings.reason, dataset.trades.reason].filter(reason => reason !== null && reason !== 'before-collection' && reason !== 'weekend'))]
        return <div key={dataset.market}>
          <p className="state">{dataset.market}
            {dataset.listingDate && ' · 종목 기준 ' + dataset.listingDate}
            {dataset.trades.tradingDate && ' · 종가 기준 ' + dataset.trades.tradingDate}
            {(dataset.trades.usingPreviousClose || details.length > 0) && <> <span className="muted-badge">
              {dataset.trades.usingPreviousClose ? '이전 정상 종가 사용' : krxStateLabels[details[0]]}
            </span></>}
          </p>
          {dataset.items.length === 20 && <small>시장별 최대 20개를 표시합니다. 검색어를 좁혀 보세요.</small>}
          {dataset.items.length ? <ClientPages key={dataset.market + ':' + query} items={dataset.items} countLabel="조회된 종목" label={dataset.market + ' 종목 목록 페이지'}>{visible =>
            <ul className="stock-list">{visible.map(item => {
              const listing = { market: 'KR', exchange: 'XKRX', symbol: item.symbol } as const
              const saved = selected.some(entry => marketSymbolKey(entry) === marketSymbolKey(listing))
              const quote = item.quote
              return <li className="terminal-stock-row" key={item.symbol}>
                <div className="terminal-symbol">
                  <a className="stock-detail-link" href={stockHref(listing)} title={item.name}><span className="krx-stock-name">{item.name}</span></a>
                  <small>{item.symbol} · {item.market}{item.shareClass && ' · ' + item.shareClass}</small>
                </div>
                <div className="terminal-metrics">
                  {quote ? <>
                    <strong>{number.format(quote.price)}원</strong>
                    {quote.change !== null && quote.changePercent !== null &&
                      <Change market="KR" quote={{ change: quote.change, percent: quote.changePercent }} />}
                    <small className="watch-trading-date"><time dateTime={quote.tradingDate}>{quote.tradingDate}</time> 종가</small>
                    <small>거래량 {quote.volume === null ? '미확인' : number.format(quote.volume)}</small>
                    {quote.turnover != null && <small>거래대금 {formatWon(quote.turnover)}</small>}
                    {quote.marketCap != null && <small>시가총액 {formatWon(quote.marketCap)}</small>}
                  </> : <small>유효한 시세 없음</small>}
                </div>
                <button type="button" className="favorite-button" disabled={blocked} aria-pressed={saved} aria-label={item.name + ' 관심종목'}
                  onClick={() => onToggle(listing)}><Star size={19} fill={saved ? 'currentColor' : 'none'} aria-hidden="true" /></button>
              </li>
            })}
          </ul>}</ClientPages> : <p className="state">{dataset.listings.status === 'unavailable' ? '종목 목록 미확인' : '검색 결과 없음'}</p>}
        </div>
      })}</>}
  </section>
}
