import { ChevronDown, Clock } from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { FinanceApiError, getKrxAnalysis, getKrxStocks, marketRequestMessage } from '../services/apiFinanceService'
import { calculatePriceReturns, calculateTechnicalIndicators, emaWindows, smaWindows } from '../services/technicalIndicators'
import type { KrxAnalysis as Analysis } from '../types/finance'
import { Change } from './QuoteDisplay'
import { krxStateLabels } from './KrxStocks'
import { KrxAfterHoursStatus } from './KrxAfterHoursStatus'
import { TechnicalSummary } from './TechnicalSummary'
import { confirmedKrxTick, formatAnalysisPrice, formatPercent } from '../services/analysisPrices'
import type { KrxStocks } from '../types/finance'

const number = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 2 })
const timestamp = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'short' })
const format = (value?: number | null) => value == null ? '자료 부족' : number.format(value)

const historyStop = {
  'not-collected': '시장 일봉 미수집',
  'missing-observation': '종목 유효 관측 없음',
}

export function KrxAnalysis({ symbol, actions, refresh = 0 }: { symbol: string; actions: ReactNode; refresh?: number }) {
  const [result, setResult] = useState<{ data: Analysis } | { message: string }>()
  const [listing, setListing] = useState<{ symbol: string; data: KrxStocks }>()
  const [revision, retry] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    void getKrxAnalysis(symbol, controller.signal).then(data => {
      if (!controller.signal.aborted) setResult({ data })
    }, error => {
      if (controller.signal.aborted) return
      const code = error instanceof FinanceApiError ? error.code : undefined
      setResult({ message: code === 'KRX_LISTING_NOT_FOUND' ? '현재 상장 목록에 이 종목이 없습니다.'
        : marketRequestMessage(error, 'KRX 일별 시계열 조회 실패') })
    })
    return () => controller.abort()
  }, [symbol, revision, refresh])

  const data = result && 'data' in result ? result.data : undefined
  const market = data?.market
  const date = data?.latestDate
  useEffect(() => {
    if (!market || !date) return
    const controller = new AbortController()
    void getKrxStocks(market, { symbol }, controller.signal).then(value => {
      if (!controller.signal.aborted) setListing({ symbol, data: value })
    }, () => { /* Analysis remains available with approximate prices. */ })
    return () => controller.abort()
  }, [market, date, symbol])
  const tick = listing?.symbol === symbol && market && date ? confirmedKrxTick(listing.data, market, symbol, date) : undefined
  const quote = data?.quote
  const history = data?.history
  const aligned = history && quote && history.bars.at(-1)?.tradingDate === quote.tradingDate && quote.tradingDate === data?.latestDate
  const indicator = useMemo(() => aligned && history ? calculateTechnicalIndicators(history) : null, [aligned, history])
  const returns = useMemo(() => indicator && history ? calculatePriceReturns(history) : {}, [indicator, history])
  const bars = data?.history.bars ?? []
  const lastClose = bars.at(-1)?.close
  const rsi = indicator?.rsi14
  const macd = indicator?.macd

  const relative = (average: number | null | undefined) => average == null || lastClose == null ? ''
    : lastClose > average ? '종가가 평균 위' : lastClose < average ? '종가가 평균 아래' : '종가와 같음'

  const histogram = macd?.histogram

  return <section className="panel stock-detail krx-analysis" aria-label="기술적 분석">
    {!data && <header className="stock-identity"><h1>{symbol}</h1>{actions}</header>}
    {!result ? <p className="state" role="status">KRX 시세를 불러오는 중입니다.</p>
      : 'message' in result || !data ? <div className="state"><p role="status">{'message' in result ? result.message : '자료 없음'}</p>
        <p>최신 위험 상태 확인 불가</p>
        <button className="button" onClick={() => { setResult(undefined); retry(value => value + 1) }}>다시 조회</button></div>
        : <>
          <header className="analysis-quote">
            <div className="stock-identity">
              <h1>{data.name}</h1>
              <small>{data.symbol} · {data.market} (XKRX) · KRW{data.shareClass && ' · ' + data.shareClass}</small>
            </div>
            {quote ? <div className="analysis-price">
              <small>KRX 정규장 종가</small>
              <strong>{formatAnalysisPrice(quote.price, 'KRW')}</strong>
              {quote.change !== null && quote.changePercent !== null &&
                <Change quote={{ change: quote.change, percent: quote.changePercent }} detailed />}
            </div> : <p className="state">최신 공식 종가 없음</p>}
            {actions}
            <div className="analysis-meta">
              {quote && <span><Clock size={14} aria-hidden="true" /> 거래일 <time dateTime={quote.tradingDate}>{quote.tradingDate}</time></span>}
              <span>{data.source} · 공식 미수정 종가</span>
              {data.reason && <span>{krxStateLabels[data.reason]}</span>}
              {data.usingPreviousClose && <span>이전 정상 종가 사용</span>}
              {data.collectedAt && <span>마지막 정상 수집 <time dateTime={data.collectedAt}>{timestamp.format(new Date(data.collectedAt))}</time> (KST)</span>}
              {data.lastAttemptAt && <span>마지막 시도 <time dateTime={data.lastAttemptAt}>{timestamp.format(new Date(data.lastAttemptAt))}</time> (KST)</span>}
            </div>
          </header>
          <KrxAfterHoursStatus details={data.afterHours} />
          <div className="analysis-heading analysis-history-status">
            <small>{bars.length ? `${bars.length}거래일 · ${bars[0].tradingDate} ~ ${bars.at(-1)?.tradingDate}`
              : '연속 일봉 부족'}</small>
          </div>
          <TechnicalSummary indicators={indicator} history={data.history} tick={tick} stale={data.reason === 'provider-error' || data.reason === 'provider-not-configured' || data.reason === 'not-published'} />
          <details className="technical-detail-group"><summary>이동평균·모멘텀·수익률 상세</summary><div className="analysis-details">
            <details>
              <summary>추세 · 이동평균 <ChevronDown size={16} aria-hidden="true" /></summary>
              <p className="heatmap-meta">EMA는 첫 전체 구간의 SMA에서 시작합니다.</p>
              <dl className="stock-detail-fields">
                {(['sma', 'ema'] as const).flatMap(kind => (kind === 'sma' ? smaWindows : emaWindows)
                  .filter(period => period !== 365 || indicator?.sma[365] != null).map(period => {
                  const value = indicator?.[kind][period]
                  return <div key={kind + period}><dt>{kind.toUpperCase()} {period}</dt><dd>{format(value)}
                    {value != null && <small>{relative(value)}</small>}</dd></div>
                }))}
              </dl>
            </details>
            <details>
              <summary>모멘텀 · RSI와 MACD <ChevronDown size={16} aria-hidden="true" /></summary>
              <p className="heatmap-meta">RSI는 최근 상승과 하락의 상대적 강도입니다. 70 이상과 30 이하는 과매수·과매도의 참고 구간입니다. MACD선은 단기·장기 이동평균의 차이이며, 히스토그램은 MACD선과 시그널선의 차이입니다. 추세와 거래량을 함께 확인하세요.</p>
              <dl className="stock-detail-fields">
                <div><dt>RSI 14</dt><dd>{format(rsi)}</dd></div>
                <div><dt>MACD 12·26</dt><dd>{format(macd?.line)}</dd></div>
                <div><dt>시그널 9</dt><dd>{format(macd?.signal)}</dd></div>
                <div><dt>히스토그램</dt><dd>{format(histogram)}</dd></div>
              </dl>
            </details>
            <details>
              <summary>기간별 성과 · 1 / 3 / 6개월 <ChevronDown size={16} aria-hidden="true" /></summary>
              <p className="heatmap-meta">미수정 종가 수익률입니다. 분할 등 기업행위에 따른 가격 변동이 반영될 수 있습니다.</p>
              <dl className="stock-detail-fields">
                {[1, 3, 6].map(months => <div key={months}><dt>{months}개월</dt>
                  <dd>{returns[months] ? <>{returns[months].percent > 0 ? '+' : ''}{formatPercent(returns[months].percent)}
                    <small>비교 거래일 <time dateTime={returns[months].tradingDate}>{returns[months].tradingDate}</time></small></> : '자료 부족'}</dd></div>)}
              </dl>
            </details>
          </div></details>
          {data.stoppedAt && data.stoppedReason && <small>{data.stoppedAt} 및 이전 제외 · {historyStop[data.stoppedReason]}</small>}
        </>}
  </section>
}
