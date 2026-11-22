import { useEffect, useState } from 'react'
import { getUsAnalysis, marketRequestMessage } from '../services/apiFinanceService'
import { calculatePriceReturns, calculateTechnicalIndicators } from '../services/technicalIndicators'
import { Change } from './QuoteDisplay'

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

export function UsAnalysis({ symbol, indexId }: { symbol: string; indexId?: string }) {
  const [state, setState] = useState<{ data: Awaited<ReturnType<typeof getUsAnalysis>> } | { error: string }>()
  const [requested, setRequested] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    void getUsAnalysis(symbol, controller.signal, requested, indexId).then(data => {
      if (!controller.signal.aborted) setState({ data })
    }, error => {
      if (!controller.signal.aborted) setState({ error: marketRequestMessage(error, '미국시장 일봉 조회 실패') })
    })
    return () => controller.abort()
  }, [symbol, requested, indexId])

  const data = state && 'data' in state ? state.data : null
  const quote = data && data.status !== 'unavailable' ? data.quote : null
  const history = data && data.status !== 'unavailable' && data.analysisStatus === 'available' ? data.history : null
  const indicators = history && calculateTechnicalIndicators(history)
  const returns = history ? calculatePriceReturns(history) : {}
  return <section className="panel stock-detail" aria-label="기술적 분석">
    <h2>기술적 분석</h2>
    {!state ? <p role="status">미국시장 일봉을 불러오는 중입니다.</p>
      : 'error' in state ? <p role="status">{state.error}</p>
      : !data || data.status === 'unavailable' || !quote ? <>
        <p role="status">{data?.reason ? messages[data.reason] : '자료 없음'}</p>
        {!indexId && !requested && data?.reason === 'not-published' &&
          <button className="button" type="button" onClick={() => { setState(undefined); setRequested(true) }}>수집 요청</button>}
      </> : <>
        <section className="panel krx-analysis-card">
          <h3>{symbol} 일별 종가</h3>
          <strong className="krx-quote-price">{format(quote.close)} {indexId ? 'pt' : 'USD'}</strong>
          {quote.change !== null && quote.changePercent !== null && <Change quote={{ change: quote.change, percent: quote.changePercent }} detailed />}
          <p className="heatmap-meta">{quote.tradingDate} · {data.source} · Yahoo 제공 종가 (Adj Close 미적용)
            {' · 수집 '}{dateTime.format(new Date(data.collectedAt))} (KST)</p>
          {data.status === 'stale' && <>
            <p role="status">마지막 정상 데이터 · {data.reason ? messages[data.reason] : '갱신 지연'}</p>
            {!indexId && !requested && data.reason === 'not-published' &&
              <button className="button" type="button" onClick={() => setRequested(true)}>갱신 요청</button>}
          </>}
          <dl className="stock-detail-fields">
            {[['시가', quote.open], ['고가', quote.high], ['저가', quote.low], ['종가', quote.close], ['거래량', quote.volume]].map(([label, value]) =>
              <div key={label}><dt>{label}</dt><dd>{indexId && label === '거래량' && value === 0 ? '미제공' : format(Number(value))}</dd></div>)}
          </dl>
        </section>
        <details>
          <summary>최근 20거래일 OHLCV {indexId ? '' : '(기업행위 조정)'}</summary>
          <div className="us-history-scroll">
            <table className="us-history-table">
              <thead><tr>{['거래일', '시가', '고가', '저가', '종가', '거래량'].map(label =>
                <th key={label} scope="col">{label}</th>)}</tr></thead>
              <tbody>{data.history.bars.slice(-20).reverse().map(bar => <tr key={bar.tradingDate}>
                <th scope="row">{bar.tradingDate}</th>
                {[bar.open, bar.high, bar.low, bar.close, bar.volume].map((value, index) =>
                  <td key={index}>{indexId && index === 4 && value === 0 ? '미제공' : format(value)}</td>)}
              </tr>)}</tbody>
            </table>
          </div>
        </details>
        {data.analysisStatus === 'insufficient-history' ? <p role="status">기술적 분석에는 유효한 260거래일 이력이 필요합니다.</p>
          : indicators && <div className="krx-analysis-grid">
            <section className="panel krx-analysis-card">
              <h3>추세 분석</h3><p>{indexId ? 'Yahoo 제공 지수 종가 기준' : 'Yahoo 배당·분할 조정 종가 기준'}</p>
              <dl className="stock-detail-fields">
                {(['sma', 'ema'] as const).flatMap(kind => [20, 50, 100, 200].map(period =>
                  <div key={kind + period}><dt>{kind.toUpperCase()} {period}</dt><dd>{format(indicators[kind][period])}</dd></div>))}
              </dl>
            </section>
            <section className="panel krx-analysis-card">
              <h3>모멘텀 분석</h3>
              <dl className="stock-detail-fields">
                <div><dt>RSI 14</dt><dd>{format(indicators.rsi14)}</dd></div>
                <div><dt>MACD 12·26</dt><dd>{format(indicators.macd.line)}</dd></div>
                <div><dt>시그널 9</dt><dd>{format(indicators.macd.signal)}</dd></div>
                <div><dt>히스토그램</dt><dd>{format(indicators.macd.histogram)}</dd></div>
                <div><dt>20일 평균 거래량</dt><dd>{indexId && indicators.volumeSma20 === 0 ? '미제공' : format(indicators.volumeSma20)}</dd></div>
              </dl>
            </section>
            <section className="panel krx-analysis-card">
              <h3>기간별 성과</h3>
              <dl className="stock-detail-fields">
                {[1, 3, 6].map(months => <div key={months}><dt>{months}개월</dt>
                  <dd>{returns[months] ? format(returns[months].percent) + '% · ' + returns[months].tradingDate : '자료 부족'}</dd></div>)}
              </dl>
            </section>
          </div>}
      </>}
  </section>
}
