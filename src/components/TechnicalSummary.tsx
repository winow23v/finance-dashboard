import { ChevronDown } from 'lucide-react'
import { useMemo } from 'react'
import { assessTechnicalTrend, type PriceZone } from '../services/technicalAssessment'
import type { TechnicalIndicators } from '../services/technicalIndicators'
import type { MarketDailyHistory } from '../types/marketDataProvider'
import { TechnicalScenarios, entryLabels } from './TechnicalScenarios'
import { buildTechnicalScenarios } from '../services/technicalScenarios'
import { technicalRisk } from '../services/technicalRisk'
import { formatAnalysisPrice, formatMetric as format, formatPercent, formatThreshold, formatVolume, formatZone, pricePolicy, type PriceDisplay } from '../services/analysisPrices'

const trendLabel = {
  up: '상승 추세', down: '하락 추세', sideways: '횡보 · 방향 미확인',
  'turn-up': '상승 전환 후보', 'turn-down': '하락 전환 주의', unavailable: '분석 불가',
}
const strengthLabel = { single: '단일 또는 보조 근거', repeated: '반복 반응', 'recent-repeated': '최근 반복 반응' }

function ZoneList({ zones, label, display, condition }: {
  zones: PriceZone[]; label: string; display: PriceDisplay; condition: string
}) {
  return <div>
    <h4>{label}</h4>
    {!zones.length ? <p className="heatmap-meta">확인할 구간 부족</p> : <ol className="technical-zones">
      {zones.map((zone, i) => <li key={zone.low}>
        <details>
          <summary><span>{i + 1}차 {label}</span><strong>{formatZone(zone, display)}</strong></summary>
          <small>{strengthLabel[zone.strength]} · 확정 피벗 {zone.reactions}회{zone.volumeReactions > 0 && ` · 거래량 급증 ${zone.volumeReactions}회`}</small>
          <small>{zone.evidence.join(' · ')} · 근거일 <time dateTime={zone.date}>{zone.date}</time></small>
          <small>{condition}</small>
        </details>
      </li>)}
    </ol>}
  </div>
}

export function TechnicalSummary({ indicators, history, index, tick, stale = false }: {
  indicators: TechnicalIndicators | null; history: MarketDailyHistory; index?: boolean; tick?: PriceDisplay['tick']; stale?: boolean
}) {
  const assessment = useMemo(() => indicators && assessTechnicalTrend(history.bars, indicators), [history, indicators])
  const plan = useMemo(() => assessment && indicators && buildTechnicalScenarios(assessment, indicators), [assessment, indicators])
  const risk = technicalRisk(assessment, indicators, stale, !index)
  if (!assessment || !indicators || !plan) return <section className="technical-summary" aria-label="기술적 분석">
    <h2>기술적 분석</h2>
    <p className="heatmap-meta" role="status">분석 불가 · {risk.status} · 기준일에 맞는 유효한 연속 확정 일봉이 필요합니다.</p>
  </section>
  const { trend, reasons, zones, invalidation, breakVolumeConfirmed, tradingDate, priceStructure } = assessment
  const { dmi, bands, volume, atr14, cross, sma, sma20Slope, rsi14, macd } = indicators
  const display: PriceDisplay = { unit: index ? 'pt' : history.currency, tick }
  const basis = history.adjustment === 'total-return-adjusted' ? '배당·분할 조정 가격'
    : history.adjustment === 'split-adjusted' ? '분할 조정 가격' : '미수정 가격'
  const upward = trend === 'up' || trend === 'turn-up'
  const entryLabel = plan.entry.mode === 'breakout' && plan.entry.breakoutPassed ? '신규 진입 검토 · 재시험 대기' : entryLabels[plan.entry.mode]
  return <>
    <section className="technical-summary" aria-label="종합 기술적 판단">
      <div className="analysis-heading">
        <h2>기술적 분석 요약</h2>
        <small><time dateTime={tradingDate}>{tradingDate}</time> 확정 일봉 · {basis}</small>
      </div>
      <dl className="technical-status">
        <div><dt>추세</dt><dd>{trendLabel[trend]}</dd></div>
        <div><dt>진입 관점</dt><dd>{entryLabel}</dd></div>
        <div><dt>위험</dt><dd><span className={stale || risk.signals.length ? "technical-risk-attention" : undefined}>{risk.status}</span></dd></div>
      </dl>
      <dl className="technical-key-metrics">
        {!index && <div><dt>SMA 20</dt><dd>{format(sma[20])}</dd></div>}
        <div><dt>RSI 14</dt><dd>{format(rsi14)}{rsi14 !== null && <small>{rsi14 >= 70 ? '과매수 구간' : rsi14 <= 30 ? '과매도 구간' : '중립 구간'}</small>}</dd></div>
        <div><dt>MACD 12·26</dt><dd>{format(macd.line)}
          {macd.line !== null && <small>{macd.histogram === null ? '시그널 자료 부족'
            : macd.histogram > 0 ? '시그널 위' : macd.histogram < 0 ? '시그널 아래' : '시그널과 같음'}</small>}</dd></div>
        <div><dt>ADX 14</dt><dd>{format(dmi.adx)}</dd></div>
        <div><dt>직전 20봉 대비 거래량</dt><dd>{volume.ratio === null ? '비교 불가' : format(volume.ratio) + '배'}</dd></div>
        <div><dt>변동성</dt><dd>{stale ? '최신 상태 미확인' : atr14 === null ? '자료 부족' : risk.signals.includes('변동성 확대') ? '확대' : 'ATR ' + format(atr14)}</dd></div>
      </dl>
      <details className="technical-risk-checks">
        <summary>확인한 위험 조건 <ChevronDown size={16} aria-hidden="true" /></summary>
        {stale && <p>아래 결과는 마지막 확인 일봉 기준입니다.</p>}
        {risk.incomplete && <p>일부 위험 조건은 자료가 부족합니다.</p>}
        <ul>{risk.checks.map(check => <li key={check.label}>{check.label} · {check.value === null ? '확인 자료 부족'
          : check.value ? '조건 감지' : '조건 미충족'}</li>)}</ul>
        <p className="heatmap-meta">기준에 잡히지 않는 위험도 있습니다. 거래량 미확인은 방향 판단과 별개입니다.</p>
      </details>
      <details className="technical-risk-checks">
        <summary>추세 판단 근거 <ChevronDown size={16} aria-hidden="true" /></summary>
        <ul className="technical-evidence">{reasons.map(reason => <li key={reason}>{reason}</li>)}</ul>
      </details>
      {invalidation !== undefined && <p className="heatmap-meta">
        추세 가설 재검토 · 확정 종가가 {formatThreshold(invalidation, display, upward ? 'down' : 'up')} {upward ? '아래' : '위'}로 이동할 때
      </p>}
      {!index && <p className="heatmap-meta">기술 지표는 과거 확정 일봉을 해석하는 참고 자료입니다.</p>}
      {trend === 'unavailable' && <p className="heatmap-meta">장기 추세 분류에는 유효한 일봉 200개가 필요합니다.</p>}
    </section>
    <section className="technical-price-zones" aria-label="지지 · 저항 구간">
      <div className="analysis-heading"><h3>지지 · 저항 구간</h3><small>{pricePolicy(display)}</small></div>
      <div className="technical-zone-grid">
        <ZoneList zones={zones.support} label="지지" display={display} condition="도달 시 종가 회복을 확인하고, 하단 이탈 시 지지 가설을 재검토합니다." />
        <ZoneList zones={zones.resistance} label="저항" display={display} condition="상단 돌파 시 확정 종가와 거래량 동반 여부를 확인합니다." />
        {!!zones.testing.length && <ZoneList zones={zones.testing} label="종가 위치" display={display} condition="종가가 구간 어느 쪽으로 벗어나는지 확인합니다." />}
      </div>
      {zones.structureAvailable && (zones.breakUp || zones.breakDown) && <p className="heatmap-meta">
        {zones.breakUp ? '종가가 직전 구간 상단 돌파' : '종가가 직전 구간 하단 이탈'}
        {' · '}{breakVolumeConfirmed == null ? '거래량 비교 불가' : breakVolumeConfirmed ? '거래량 급증 동반' : '거래량 급증 기준 미달'}
      </p>}
      <details className="technical-risk-checks">
        <summary>추세선 후보 및 산출 근거 <ChevronDown size={16} aria-hidden="true" /></summary>
        {priceStructure.channel && <p>채널 후보 · {formatAnalysisPrice(priceStructure.channel.lower, display.unit)} ~ {formatAnalysisPrice(priceStructure.channel.upper, display.unit)}</p>}
        {([['고점 추세선', priceStructure.upper], ['저점 추세선', priceStructure.lower]] as const).map(([label, line]) => line && line.latest > 0 &&
          <p key={label}>{label} · {formatAnalysisPrice(line.latest, display.unit)} <small>확정 스윙 {line.from.date} · {line.to.date}</small></p>)}
        <p className="heatmap-meta">좌우 2봉으로 확정된 스윙, 직전 20·60·120거래일 극값과 이동평균을 직전 ATR로 묶습니다. 화면 범위는 하단을 내리고 상단을 올려 표시합니다. 돌파와 이탈 판정에는 이전 봉까지 확정된 원시 계산 구간을 사용합니다.</p>
      </details>
    </section>
    {!index && <TechnicalScenarios plan={plan} tradingDate={tradingDate} display={display} stale={stale} />}
    <details className="technical-detail-group"><summary>추세 강도·변동성·거래량 상세</summary>
    <div className="analysis-details">
      <details>
        <summary>추세 강도 · 이동평균 교차 <ChevronDown size={16} aria-hidden="true" /></summary>
        <p className="heatmap-meta">ADX는 추세의 강도를 나타냅니다. 방향은 +DI(상승 압력)와 −DI(하락 압력)를 비교합니다. ADX는 14기간 Wilder 방식으로 계산합니다. 장기·중기 추세가 일치하고 ADX가 25 이상이면 추세로, 중기 방향 전환과 모멘텀이 일치하고 ADX가 20 이상이면 전환 후보로 평가합니다.</p>
        <dl className="stock-detail-fields">
          <div><dt>ADX 14</dt><dd>{format(dmi.adx)}</dd></div>
          <div><dt>+DI 14</dt><dd>{format(dmi.plus)}</dd></div>
          <div><dt>−DI 14</dt><dd>{format(dmi.minus)}</dd></div>
          <div><dt>20일 이동평균 변화</dt><dd>{sma20Slope === null ? '자료 부족' : sma20Slope === 0 ? '직전 거래일과 같음'
            : `직전 거래일보다 약 ${display.unit === 'KRW' ? formatAnalysisPrice(Math.round(Math.abs(sma20Slope)), 'KRW')
              : formatAnalysisPrice(Math.abs(sma20Slope), display.unit)} ${sma20Slope > 0 ? '상승' : '하락'}`}
            <small>현재 SMA20에서 직전 확정 봉의 SMA20을 뺀 값</small></dd></div>
          <div><dt>SMA 50/200 배열</dt><dd>{sma[50] === null || sma[200] === null ? '자료 부족' : sma[50] > sma[200] ? '50 > 200' : sma[50] < sma[200] ? '50 < 200' : '같음'}</dd></div>
          <div><dt>최근 실제 교차</dt><dd>{cross.lastEvent
            ? <>{cross.lastEvent.type === 'golden' ? '골든크로스' : '데드크로스'} · <time dateTime={cross.lastEvent.tradingDate}>{cross.lastEvent.tradingDate}</time></>
            : '확인된 교차 없음'}</dd></div>
        </dl>
      </details>
      <details>
        <summary>변동성 · 거래량 <ChevronDown size={16} aria-hidden="true" /></summary>
        <p className="heatmap-meta">ATR은 최근 가격이 얼마나 크게 움직였는지 보여 줍니다. 값이 커지면 가격 변동 위험도 커질 수 있으며 위험 관리 후보에 활용합니다. 14개 진폭의 평균으로 시작해 Wilder 방식으로 갱신합니다. 볼린저밴드는 20개 종가의 모표준편차에 2를 곱합니다. 5일·20일 이동평균에는 기준일 봉을 포함합니다. 상대 거래량의 기준 평균은 당일을 제외한 직전 20개 확정 봉입니다.</p>
        <dl className="stock-detail-fields">
          <div><dt>ATR 14</dt><dd>{format(atr14)}</dd></div>
          <div><dt>볼린저 상단</dt><dd>{format(bands?.upper)}</dd></div>
          <div><dt>볼린저 중심</dt><dd>{format(bands?.middle)}</dd></div>
          <div><dt>볼린저 하단</dt><dd>{format(bands?.lower)}</dd></div>
          <div><dt>%B</dt><dd>{bands?.percentB == null ? '산출 불가' : formatPercent(bands.percentB)}</dd></div>
          <div><dt>밴드 폭</dt><dd>{bands?.bandwidth == null ? '자료 부족' : formatPercent(bands.bandwidth)}</dd></div>
          <div><dt>거래량 평균 5 / 20 / 50</dt><dd>{index && volume.latest === 0 ? '미제공' : [formatVolume(volume.sma5), formatVolume(indicators.volumeSma20), formatVolume(indicators.volumeSma50)].join(' / ')}</dd></div>
          <div><dt>직전 20거래일 대비</dt><dd>{volume.ratio === null ? '비교 불가' : format(volume.ratio) + '배'}<small>급증 기준 {format(volume.spikeThreshold)}배</small></dd></div>
        </dl>
      </details>
    </div>
    </details>
  </>
}
