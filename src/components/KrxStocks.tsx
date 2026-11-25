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
  'before-collection': '다음 확정 종가 수집 대기',
}

export function KrxStocks({ selected, onToggle, symbol, blocked }: {
  selected: MarketSymbol[]
  blocked?: boolean
  onToggle: (listing: MarketSymbol) => void
  symbol?: string
}) {
  const [market, setMarket] = useState<KrxMarket>('KOSPI')
  const [input, setInput] = useState('')
  const [query, setQuery] = useState('')
  const [revision, setRevision] = useState(0)
  const [result, setResult] = useState<{ market: KrxMarket; query: string; revision: number; data: StockResults[] | null; message: string }>()
  const current = result?.market === market && result.query === query && result.revision === revision ? result : undefined

  useEffect(() => {
    if (!symbol && !query) return
    const controller = new AbortController()
    const markets: KrxMarket[] = symbol ? ['KOSPI', 'KOSDAQ'] : [market]
    const filters = symbol ? { symbol } : query ? { q: query } : {}
    void Promise.allSettled(markets.map(value => getKrxStocks(value, filters, controller.signal))).then(outcomes => {
      if (controller.signal.aborted) return
      const data = outcomes.flatMap(outcome => outcome.status === 'fulfilled' ? [outcome.value] : [])
      const failure = outcomes.find(outcome => outcome.status === 'rejected')
      setResult({ market, query, revision, data: data.length ? data : null,
        message: marketRequestMessage(failure?.reason, '국내 종목 조회 실패') })
    })
    return () => controller.abort()
  }, [market, query, revision, symbol])

  return <section className="panel watch-panel krx-stock-search" aria-label="국내 종목 시세">
    <div className="panel-heading"><h2><Search size={18} aria-hidden="true" /> 국내 종목 시세</h2></div>
    {!symbol && <form className="disclosure-controls terminal-filters krx-search-controls" onSubmit={event => {
      event.preventDefault()
      if (!input.trim() || (input.trim() === query && current?.data !== null)) return
      setQuery(input.trim())
      setRevision(value => value + 1)
    }}>
      <label><span><SlidersHorizontal size={14} aria-hidden="true" /> 시장</span><select value={market} onChange={event => setMarket(event.target.value as KrxMarket)}>
        <option>KOSPI</option><option>KOSDAQ</option>
      </select></label>
      <label>종목명 또는 단축코드 <input type="search" placeholder="예: 삼성전자 또는 005930" value={input} maxLength={64} onChange={event => setInput(event.target.value)} /></label>
      <button type="submit" className="button" disabled={!input.trim()}>검색</button>
      {(input || query) && <button type="button" className="button" onClick={() => {
        setInput('')
        setQuery('')
        setMarket('KOSPI')
      }}><X size={16} aria-hidden="true" /> 초기화</button>}
    </form>}
    {!symbol && !query ? <p className="state">KOSPI 또는 KOSDAQ을 선택하고 종목명이나 코드를 입력하세요.</p> : !current ? <LoadingSkeleton message="국내 종목을 불러오는 중입니다." shape="rows" /> : current.data === null
      ? <p className="state" role="status">{current.message}</p>
      : current.data.map(dataset => {
        const details = [...new Set([dataset.listings.reason, dataset.trades.reason].filter(reason => reason !== null))]
        return <div key={dataset.market}>
          <p className="state">{dataset.market}
            {dataset.listingDate && ' · 종목 기준 ' + dataset.listingDate}
            {dataset.trades.tradingDate && ' · 종가 기준 ' + dataset.trades.tradingDate}
            {(dataset.trades.usingPreviousClose || details.length > 0) && <> <span className="muted-badge">
              {dataset.trades.usingPreviousClose ? '이전 정상 종가 사용' : krxStateLabels[details[0]]}
            </span></>}
          </p>
          {dataset.items.length ? <ul className="stock-list">
            {dataset.items.map(item => {
              const listing = { market: 'KR', exchange: 'XKRX', symbol: item.symbol } as const
              const saved = selected.some(entry => marketSymbolKey(entry) === marketSymbolKey(listing))
              const quote = item.quote
              return <li className="terminal-stock-row" key={item.symbol}>
                <div className="terminal-symbol">
                  <a className="stock-detail-link" href={stockHref(listing)}>{item.name}</a>
                  <small>{item.symbol} · {item.market}{item.shareClass && ' · ' + item.shareClass}</small>
                </div>
                <div className="terminal-metrics">
                  {quote ? <>
                    <strong>{number.format(quote.price)}원</strong>
                    {quote.change !== null && quote.changePercent !== null &&
                      <Change quote={{ change: quote.change, percent: quote.changePercent }} />}
                    <small className="watch-trading-date"><time dateTime={quote.tradingDate}>{quote.tradingDate}</time> 종가</small>
                    <small>거래량 {quote.volume === null ? '미확인' : number.format(quote.volume)}</small>
                  </> : <small>유효한 시세 없음</small>}
                </div>
                <button type="button" className="favorite-button" disabled={blocked} aria-pressed={saved} aria-label={item.name + ' 관심종목'}
                  onClick={() => onToggle(listing)}><Star size={19} fill={saved ? 'currentColor' : 'none'} aria-hidden="true" /></button>
              </li>
            })}
          </ul> : <p className="state">{dataset.listings.status === 'unavailable' ? '종목 목록 미확인' : '검색 결과 없음'}</p>}
        </div>
      })}
  </section>
}
