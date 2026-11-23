import { ChevronDown } from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { getUsAnalysis, marketRequestMessage } from '../services/apiFinanceService'
import { calculatePriceReturns, calculateTechnicalIndicators, emaWindows, smaWindows } from '../services/technicalIndicators'
import { Change } from './QuoteDisplay'
import { TechnicalSummary } from './TechnicalSummary'
import { formatAnalysisPrice, formatPercent, formatVolume } from '../services/analysisPrices'

const number = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 2 })
const dateTime = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'short' })
const format = (value?: number | null) => value == null ? '자료 부족' : number.format(value)
const messages = {
  'provider-not-configured': '미국시장 데이터 공급자 미연결',
  'not-published': '수집된 거래일 데이터가 없습니다.',
  collecting: '수집 대기 중입니다. 다음 수집 이후 다시 확인해 주세요.',
  'provider-error': '공급자 수집에 실패했습니다.',
  'rate-limited': '수집 요청 한도에 도달했습니다.',
  unsupported: '지원되는 미국 상장 종목을 확인할 수 없습니다.',
}

export function UsAnalysis({ symbol, indexId, stock, refresh = 0 }: {
  symbol: string; indexId?: string; stock?: { name: string; meta: string; actions: ReactNode }; refresh?: number
}) {
  const [state, setState] = useState<{ data: Awaited<ReturnType<typeof getUsAnalysis>> } | { error: string }>()
  const [requestedAt, setRequestedAt] = useState<number>()
  const requested = requestedAt === refresh
  const [revision, retry] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    void getUsAnalysis(symbol, controller.signal, requested, indexId).then(data => {
      if (!controller.signal.aborted) setState({ data })
    }, error => {
      if (!controller.signal.aborted) setState({ error: marketRequestMessage(error, '미국시장 일봉 조회 실패') })
    })
    return () => controller.abort()
  }, [symbol, requested, indexId, revision, refresh])

  const data = state && 'data' in state ? state.data : null
  const quote = data && data.status !== 'unavailable' ? data.quote : null
  const history = data && data.status !== 'unavailable' ? data.history : null
  const unit = indexId ? 'pt' : 'USD'
  const aligned = !!quote && history?.bars.at(-1)?.tradingDate === quote.tradingDate
  const indicators = useMemo(() => history && aligned ? calculateTechnicalIndicators(history) : null, [history, aligned])
  const returns = useMemo(() => history && indicators ? calculatePriceReturns(history) : {}, [history, indicators])
  return <section className="panel stock-detail krx-analysis" aria-label="기술적 분석">
    {stock && !quote && <header className="stock-identity"><h1>{stock.name}</h1><small>{stock.meta}</small>{stock.actions}</header>}
    {!stock && <h2>기술적 분석</h2>}
    {!state ? <p role="status">미국시장 일봉을 불러오는 중입니다.</p>
      : 'error' in state ? <div><p role="status">{state.error}</p><p>최신 위험 상태 확인 불가</p>
        <button className="button" onClick={() => { setState(undefined); setRequestedAt(undefined); retry(value => value + 1) }}>다시 조회</button></div>
      : !data || data.status === 'unavailable' || !quote ? <>
        <p role="status">{data?.reason ? messages[data.reason] : '자료 없음'}</p>
        <p>{data?.reason === 'provider-error' || data?.reason === 'provider-not-configured'
          ? '최신 위험 상태 확인 불가' : '위험 분석 자료 부족'}</p>
        {!indexId && !requested && data?.reason === 'not-published' &&
          <button className="button" type="button" onClick={() => { setState(undefined); setRequestedAt(refresh) }}>수집 요청</button>}
      </> : <>
        <header className="analysis-quote us-analysis-quote">
          {stock ? <div className="stock-identity"><h1>{stock.name}</h1><small>{stock.meta}</small></div>
            : <h3>{symbol} 일별 종가</h3>}
          <div className="analysis-price"><small>최신 확인 종가</small>
          <strong className="us-quote-price" title={String(quote.close)}>{formatAnalysisPrice(quote.close, unit)}</strong>
          {quote.change !== null && quote.changePercent !== null && <Change quote={{ change: quote.change, percent: quote.changePercent }} detailed />}
          </div>{stock?.actions}
          <p className="heatmap-meta analysis-meta">{quote.tradingDate} · {data.source} · Yahoo 제공 종가 (Adj Close 미적용)
            {' · 수집 '}{dateTime.format(new Date(data.collectedAt))} (KST)</p>
          {data.status === 'stale' && <>
            <p role="status">마지막 정상 데이터 · {data.reason ? messages[data.reason] : '갱신 지연'}</p>
            {!indexId && !requested && data.reason === 'not-published' &&
              <button className="button" type="button" onClick={() => setRequestedAt(refresh)}>갱신 요청</button>}
          </>}
        </header>
        {history && <TechnicalSummary indicators={indicators} history={history} index={!!indexId} stale={data.status === 'stale'} />}
        <details>
          <summary>최근 20거래일 OHLCV {indexId ? '' : '(기업행위 조정)'}</summary>
          <div className="us-history-scroll">
            <table className="us-history-table">
              <thead><tr>{['거래일', '시가', '고가', '저가', '종가', '거래량'].map(label =>
                <th key={label} scope="col">{label}</th>)}</tr></thead>
              <tbody>{data.history.bars.slice(-20).reverse().map(bar => <tr key={bar.tradingDate}>
                <th scope="row">{bar.tradingDate}</th>
                {[bar.open, bar.high, bar.low, bar.close, bar.volume].map((value, index) =>
                  <td key={index} title={index === 4 ? undefined : String(value)}>{index === 4 ? (indexId && value === 0 ? '미제공' : formatVolume(value)) : formatAnalysisPrice(value, unit)}</td>)}
              </tr>)}</tbody>
            </table>
          </div>
        </details>
        {indicators && <details className="technical-detail-group"><summary>이동평균·모멘텀·수익률 상세</summary><div className="analysis-details">
            <details>
              <summary>추세 분석 <ChevronDown size={16} aria-hidden="true" /></summary><p>{indexId ? 'Yahoo 제공 지수 종가 기준' : 'Yahoo 배당·분할 조정 종가 기준'}</p>
              <dl className="stock-detail-fields">
                {(['sma', 'ema'] as const).flatMap(kind => (kind === 'sma' ? smaWindows : emaWindows)
                  .filter(period => period !== 365 || indicators.sma[365] !== null).map(period =>
                  <div key={kind + period}><dt>{kind.toUpperCase()} {period}</dt><dd>{format(indicators[kind][period])}</dd></div>))}
              </dl>
            </details>
            <details>
              <summary>모멘텀 분석 <ChevronDown size={16} aria-hidden="true" /></summary>
              <p className="heatmap-meta">RSI는 상승·하락의 상대적 강도입니다. 70 이상과 30 이하는 과매수·과매도의 참고 구간입니다. MACD선은 단기·장기 이동평균의 차이입니다. 시그널선과의 간격을 나타내는 히스토그램을 추세·거래량과 함께 보세요.</p>
              <dl className="stock-detail-fields">
                <div><dt>RSI 14</dt><dd>{format(indicators.rsi14)}</dd></div>
                <div><dt>MACD 12·26</dt><dd>{format(indicators.macd.line)}</dd></div>
                <div><dt>시그널 9</dt><dd>{format(indicators.macd.signal)}</dd></div>
                <div><dt>히스토그램</dt><dd>{format(indicators.macd.histogram)}</dd></div>
                <div><dt>20일 평균 거래량</dt><dd>{indexId && indicators.volumeSma20 === 0 ? '미제공' : format(indicators.volumeSma20)}</dd></div>
              </dl>
            </details>
            <details>
              <summary>기간별 성과 <ChevronDown size={16} aria-hidden="true" /></summary>
              <dl className="stock-detail-fields">
                {[1, 3, 6].map(months => <div key={months}><dt>{months}개월</dt>
                  <dd>{returns[months] ? formatPercent(returns[months].percent) + ' · ' + returns[months].tradingDate : '자료 부족'}</dd></div>)}
              </dl>
            </details>
          </div></details>}
      </>}
  </section>
}
