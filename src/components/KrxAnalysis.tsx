import { useEffect, useState } from 'react'
import { FinanceApiError, getKrxAnalysis, marketRequestMessage } from '../services/apiFinanceService'
import { calculatePriceReturns, calculateTechnicalIndicators } from '../services/technicalIndicators'
import type { KrxAnalysis as Analysis } from '../types/finance'
import { Change } from './QuoteDisplay'
import { krxStateLabels } from './KrxStocks'

const number = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 2 })
const signed = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 2, signDisplay: 'exceptZero' })
const timestamp = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'short' })
const format = (value?: number | null) => value == null ? '자료 부족' : number.format(value)

export function KrxAnalysis({ symbol }: { symbol: string }) {
  const [result, setResult] = useState<{ data: Analysis } | { message: string }>()
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
  }, [symbol])

  const data = result && 'data' in result ? result.data : undefined
  const quote = data?.quote
  const indicator = data ? calculateTechnicalIndicators(data.history) : null
  const returns = data ? calculatePriceReturns(data.history) : {}
  const bars = data?.history.bars ?? []
  const lastClose = bars.at(-1)?.close
  const sma20 = indicator?.sma[20]
  const slope = indicator?.sma20Slope
  const rsi = indicator?.rsi14
  const macd = indicator?.macd

  const volumeRatio = quote?.volume != null && indicator?.volumeSma20 != null && indicator.volumeSma20 > 0
    ? quote.volume / indicator.volumeSma20 : null
  const relative = (average: number | null | undefined) => average == null || lastClose == null ? ''
    : lastClose > average ? '종가가 평균 위' : lastClose < average ? '종가가 평균 아래' : '종가와 같음'

  return <section className="panel stock-detail" aria-label="기술적 분석">
    <h2>기술적 분석</h2>
    {!result ? <p className="state" role="status">KRX 시세를 불러오는 중입니다.</p>
      : 'message' in result || !data ? <p className="state" role="status">{'message' in result ? result.message : '자료 없음'}</p>
        : <>
          <section className="panel krx-analysis-card" aria-label="종목 요약">
            <h3>{data.name} <small>{data.symbol} · {data.market}</small></h3>
            {quote ? <>
              <strong className="krx-quote-price">{number.format(quote.price)}원</strong>
              {quote.change !== null && quote.changePercent !== null &&
                <Change quote={{ change: quote.change, percent: quote.changePercent }} detailed />}
              <p className="heatmap-meta">거래일 <time dateTime={quote.tradingDate}>{quote.tradingDate}</time>
                {' · '}{data.source} · 공식 실제 종가 (미수정)
                {data.collectedAt && <> · 수집 <time dateTime={data.collectedAt}>{timestamp.format(new Date(data.collectedAt))}</time> (KST)</>}
                {data.reason && ' · ' + krxStateLabels[data.reason] + (data.reason === 'provider-error' ? ' (마지막 유효값)' : '')}
              </p>
            </> : <p className="state">최신 공식 종가 없음</p>}
          </section>
          <p className="heatmap-meta">{bars.length ? `${bars[0].tradingDate} ~ ${bars.at(-1)?.tradingDate} · ${bars.length}거래일`
            : '계산할 수 있는 연속 OHLCV 없음'}
            {data.stoppedAt && ' · ' + data.stoppedAt + ' 및 이전 제외 (' +
              (data.stoppedReason === 'not-collected' ? '미수집' : '정지 또는 유효 관측 없음') + ')'}</p>
          <div className="krx-analysis-grid">
            <section className="panel krx-analysis-card">
              <h3>추세 분석</h3>
              <p className="heatmap-meta">SMA 20 방향 {slope == null ? '자료 부족' : slope > 0 ? '상승' : slope < 0 ? '하락' : '보합'}{sma20 != null ? ' · ' + relative(sma20) : ''}. EMA는 첫 전체 구간의 SMA로 시작합니다.</p>
              <dl className="stock-detail-fields">
                {[20, 50, 200].map(period => <div key={'sma' + period}><dt>SMA {period}</dt><dd>{format(indicator?.sma[period])}
                  {indicator?.sma[period] != null && <small>{relative(indicator.sma[period])}</small>}</dd></div>)}
                {[20, 50, 100, 200].map(period => <div key={'ema' + period}><dt>EMA {period}</dt><dd>{format(indicator?.ema[period])}
                  {indicator?.ema[period] != null && <small>{relative(indicator.ema[period])}</small>}</dd></div>)}
              </dl>
            </section>
            <section className="panel krx-analysis-card">
              <h3>모멘텀 분석</h3>
              <p className="heatmap-meta">RSI 14는 상승폭과 하락폭의 균형을 나타냅니다. 히스토그램은 MACD 선에서 시그널을 뺀 값입니다.</p>
              <dl className="stock-detail-fields">
                <div><dt>RSI 14</dt><dd>{format(rsi)}{rsi != null && (rsi >= 70 ? ' · 과매수 구간' : rsi <= 30 ? ' · 과매도 구간' : ' · 중립 구간')}</dd></div>
                <div><dt>MACD 12·26</dt><dd>{format(macd?.line)}</dd></div>
                <div><dt>시그널 9</dt><dd>{format(macd?.signal)}</dd></div>
                <div><dt>히스토그램</dt><dd>{format(macd?.histogram)}{macd?.histogram != null
                  && (macd.histogram > 0 ? ' · 신호선 위' : macd.histogram < 0 ? ' · 신호선 아래' : ' · 신호선과 같음')}</dd></div>
              </dl>
            </section>
            <section className="panel krx-analysis-card">
              <h3>거래량 분석</h3>
              <p className="heatmap-meta">{volumeRatio === null ? '20거래일 비교 자료가 부족합니다.'
                : volumeRatio === 1 ? '최신 거래량이 20거래일 평균과 같습니다.'
                  : '최신 거래량이 20거래일 평균보다 ' + number.format(Math.abs(volumeRatio - 1) * 100) + '% ' + (volumeRatio > 1 ? '많습니다.' : '적습니다.')}</p>
              <dl className="stock-detail-fields">
                <div><dt>최신 거래량</dt><dd>{quote?.volume == null ? '미확인' : number.format(quote.volume) + '주'}</dd></div>
                <div><dt>20일 평균</dt><dd>{indicator?.volumeSma20 == null ? '자료 부족' : format(indicator.volumeSma20) + '주'}</dd></div>
                <div><dt>평균 대비</dt><dd>{volumeRatio === null ? '자료 부족' : number.format(volumeRatio) + '배'}</dd></div>
              </dl>
            </section>
            <section className="panel krx-analysis-card">
              <h3>기간별 성과</h3>
              <p className="heatmap-meta">배당을 제외한 미수정 종가 수익률입니다.</p>
              <dl className="stock-detail-fields">
                {[1, 3, 6].map(months => <div key={months}><dt>{months}개월</dt>
                  <dd>{returns[months] ? signed.format(returns[months].percent) + '% · ' + returns[months].tradingDate : '자료 부족'}</dd></div>)}
              </dl>
            </section>
          </div>
        </>}
  </section>
}
