import { Activity, BarChart3, ChevronDown, Clock, TrendingUp, type LucideIcon } from 'lucide-react'
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

const historyStop = {
  'not-collected': '시장 일봉 미수집',
  'missing-observation': '종목 유효 관측 없음',
}

function AnalysisMetric({ icon: Icon, label, value, status }: {
  icon: LucideIcon; label: string; value: string; status?: string
}) {
  return <div className="analysis-metric">
    <dt><Icon size={16} strokeWidth={1.75} aria-hidden="true" />{label}</dt>
    <dd><strong>{value}</strong>{status && <small>{status}</small>}</dd>
  </div>
}

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

  const trend = slope == null ? '자료 부족' : slope > 0 ? '상승' : slope < 0 ? '하락' : '보합'
  const rsiStatus = rsi == null ? undefined : rsi >= 70 ? '과매수 구간' : rsi <= 30 ? '과매도 구간' : '중립 구간'
  const histogram = macd?.histogram
  const macdStatus = histogram == null ? undefined : histogram > 0 ? '시그널 위' : histogram < 0 ? '시그널 아래' : '시그널과 동일'

  return <section className="panel stock-detail krx-analysis" aria-label="기술적 분석">
    {!result ? <p className="state" role="status">KRX 시세를 불러오는 중입니다.</p>
      : 'message' in result || !data ? <p className="state" role="status">{'message' in result ? result.message : '자료 없음'}</p>
        : <>
          <header className="analysis-quote">
            <div>
              <h2>{data.name}</h2>
              <small>{data.symbol} · {data.market} (XKRX) · KRW</small>
            </div>
            {quote ? <div className="analysis-price">
              <small>최신 확인 종가</small>
              <strong>{number.format(quote.price)}원</strong>
              {quote.change !== null && quote.changePercent !== null &&
                <Change quote={{ change: quote.change, percent: quote.changePercent }} detailed />}
            </div> : <p className="state">최신 공식 종가 없음</p>}
            <div className="analysis-meta">
              {quote && <span><Clock size={14} aria-hidden="true" /> 거래일 <time dateTime={quote.tradingDate}>{quote.tradingDate}</time></span>}
              <span>{data.source} · 공식 미수정 종가</span>
              {data.reason && <span>{krxStateLabels[data.reason]}{data.reason === 'provider-error' && ' (마지막 유효값)'}</span>}
              {data.collectedAt && <span>수집 <time dateTime={data.collectedAt}>{timestamp.format(new Date(data.collectedAt))}</time> (KST)</span>}
            </div>
          </header>
          <div className="analysis-heading">
            <h2>기술적 분석</h2>
            <small>{bars.length ? `${bars.length}거래일 · ${bars[0].tradingDate} ~ ${bars.at(-1)?.tradingDate}`
              : '연속 일봉 부족'}</small>
          </div>
          <dl className="analysis-metrics">
            <AnalysisMetric icon={TrendingUp} label="SMA 20 방향" value={trend} status={relative(sma20)} />
            <AnalysisMetric icon={Activity} label="RSI 14" value={format(rsi)} status={rsiStatus} />
            <AnalysisMetric icon={Activity} label="MACD 12·26·9" value={format(macd?.line)} status={macdStatus} />
            <AnalysisMetric icon={BarChart3} label="거래량 / 20일 평균"
              value={volumeRatio === null ? '자료 부족' : number.format(volumeRatio) + '배'} />
          </dl>
          <div className="analysis-details">
            <details>
              <summary>추세 · 이동평균 <ChevronDown size={16} aria-hidden="true" /></summary>
              <p className="heatmap-meta">EMA는 첫 전체 구간의 SMA에서 시작합니다.</p>
              <dl className="stock-detail-fields">
                {(['sma', 'ema'] as const).flatMap(kind => [20, 50, 100, 200].map(period => {
                  const value = indicator?.[kind][period]
                  return <div key={kind + period}><dt>{kind.toUpperCase()} {period}</dt><dd>{format(value)}
                    {value != null && <small>{relative(value)}</small>}</dd></div>
                }))}
              </dl>
            </details>
            <details>
              <summary>모멘텀 · RSI와 MACD <ChevronDown size={16} aria-hidden="true" /></summary>
              <p className="heatmap-meta">RSI의 과매도 기준은 30 이하, 과매수 기준은 70 이상입니다. 히스토그램은 MACD에서 시그널을 뺀 값입니다.</p>
              <dl className="stock-detail-fields">
                <div><dt>RSI 14</dt><dd>{format(rsi)}</dd></div>
                <div><dt>MACD 12·26</dt><dd>{format(macd?.line)}</dd></div>
                <div><dt>시그널 9</dt><dd>{format(macd?.signal)}</dd></div>
                <div><dt>히스토그램</dt><dd>{format(histogram)}</dd></div>
              </dl>
            </details>
            <details>
              <summary>거래량 · 20일 평균 <ChevronDown size={16} aria-hidden="true" /></summary>
              <dl className="stock-detail-fields">
                <div><dt>최신 거래량</dt><dd>{quote?.volume == null ? '미확인' : number.format(quote.volume) + '주'}</dd></div>
                <div><dt>20일 평균</dt><dd>{indicator?.volumeSma20 == null ? '자료 부족' : format(indicator.volumeSma20) + '주'}</dd></div>
              </dl>
            </details>
            <details>
              <summary>기간별 성과 · 1 / 3 / 6개월 <ChevronDown size={16} aria-hidden="true" /></summary>
              <p className="heatmap-meta">배당을 제외한 미수정 종가 수익률입니다.</p>
              <dl className="stock-detail-fields">
                {[1, 3, 6].map(months => <div key={months}><dt>{months}개월</dt>
                  <dd>{returns[months] ? <>{signed.format(returns[months].percent)}%
                    <small>비교 거래일 <time dateTime={returns[months].tradingDate}>{returns[months].tradingDate}</time></small></> : '자료 부족'}</dd></div>)}
              </dl>
            </details>
          </div>
          {data.stoppedAt && data.stoppedReason && <small>{data.stoppedAt} 및 이전 제외 · {historyStop[data.stoppedReason]}</small>}
        </>}
  </section>
}
