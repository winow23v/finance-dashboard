import { ChevronDown } from 'lucide-react'
import { useMemo } from 'react'
import { assessTechnicalTrend, type PriceZone } from '../services/technicalAssessment'
import type { TechnicalIndicators } from '../services/technicalIndicators'
import type { MarketDailyHistory } from '../types/marketDataProvider'
import { TechnicalScenarios } from './TechnicalScenarios'

const number = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 4 })
const format = (value: number | null | undefined) => value == null ? '자료 부족' : number.format(value)
const trendLabel = {
  up: '상승 추세', down: '하락 추세', sideways: '횡보 · 방향 미확인',
  'turn-up': '상승 전환 후보', 'turn-down': '하락 전환 주의', unavailable: '분석 불가',
}
const entryLabel = {
  pullback: '눌림목 대기', breakout: '돌파 확인 대기', chase: '추격매수 주의', watch: '관망', unavailable: '분석 불가',
}
const strengthLabel = { single: '단일 또는 보조 근거', repeated: '반복 반응', 'recent-repeated': '최근 반복 반응' }

function ZoneList({ zones, label, unit }: { zones: PriceZone[]; label: string; unit: string }) {
  if (!zones.length) return null
  return <div>
    <h4>{label}</h4>
    <ol className="technical-zones">
      {zones.map(zone => <li key={zone.low}>
        <strong>{format(zone.low)} ~ {format(zone.high)} {unit}</strong>
        <small>{strengthLabel[zone.strength]} · 확정 피벗 {zone.reactions}회{zone.volumeReactions > 0 && ` · 거래량 급증 ${zone.volumeReactions}회`} · {zone.evidence.join(' · ')}</small>
        <small>최근 근거일 <time dateTime={zone.date}>{zone.date}</time></small>
      </li>)}
    </ol>
  </div>
}

export function TechnicalSummary({ indicators, history, index, stale = false }: {
  indicators: TechnicalIndicators | null; history: MarketDailyHistory; index?: boolean; stale?: boolean
}) {
  const assessment = useMemo(() => indicators && assessTechnicalTrend(history.bars, indicators), [history, indicators])
  if (!assessment || !indicators) return <p className="state" role="status">분석 불가 · 유효한 연속 확정 일봉을 확인할 수 없습니다.</p>
  const { trend, entry, reasons, risks, zones, invalidation, breakVolumeConfirmed, tradingDate } = assessment
  const { dmi, bands, volume, atr14, cross, sma, sma20Slope } = indicators
  const unit = index ? 'pt' : history.currency
  const basis = history.adjustment === 'total-return-adjusted' ? '배당·분할 조정 가격'
    : history.adjustment === 'split-adjusted' ? '분할 조정 가격' : '미수정 가격'
  return <>
    <section className="technical-summary" aria-label="종합 기술적 판단">
      <div className="analysis-heading">
        <h3>종합 기술적 판단</h3>
        <small><time dateTime={tradingDate}>{tradingDate}</time> 확정 일봉 · {basis}</small>
      </div>
      <dl className="technical-status">
        <div><dt>추세</dt><dd>{trendLabel[trend]}</dd></div>
        <div><dt>진입 관점</dt><dd>{entryLabel[entry]}</dd></div>
        <div><dt>위험</dt><dd>{risks.length ? risks.join(' · ') : '설정된 위험 조건에 해당 없음'}</dd></div>
      </dl>
      <ul className="technical-evidence">{reasons.map(reason => <li key={reason}>{reason}</li>)}</ul>
      {invalidation !== undefined && <p className="heatmap-meta">
        추세 가설 재검토 · 확정 종가가 {format(invalidation)} {unit} {trend === 'up' || trend === 'turn-up' ? '아래' : '위'}로 이동할 때
      </p>}
      {trend === 'unavailable' && <p className="heatmap-meta">장기 추세 분류에는 유효한 일봉 200개가 필요합니다.</p>}
    </section>
    {!index && <TechnicalScenarios assessment={assessment} indicators={indicators} unit={unit} stale={stale} />}
    <div className="analysis-details">
      <details>
        <summary>지지 · 저항 구간 <ChevronDown size={16} aria-hidden="true" /></summary>
        <p className="heatmap-meta">좌우 2봉으로 확정된 피벗과 직전 20·60·120거래일 극값 및 이동평균을 직전 ATR로 묶습니다. 돌파와 이탈은 이전 봉에서 확정한 구간을 기준으로 확인합니다.</p>
        {zones.support.length + zones.resistance.length + zones.testing.length === 0 && <p role="status">구간을 계산할 자료가 부족합니다.</p>}
        <ZoneList zones={zones.support} label="지지 후보" unit={unit} />
        <ZoneList zones={zones.resistance} label="저항 후보" unit={unit} />
        <ZoneList zones={zones.testing} label="종가가 위치한 구간" unit={unit} />
        {(zones.breakUp || zones.breakDown) && <p>
          {zones.breakUp ? '종가가 직전 구간 상단 돌파' : '종가가 직전 구간 하단 이탈'}
          {' · '}{breakVolumeConfirmed == null ? '거래량 비교 불가' : breakVolumeConfirmed ? '거래량 급증 동반' : '거래량 급증 기준 미달'}
        </p>}
      </details>
      <details>
        <summary>추세 강도 · 이동평균 교차 <ChevronDown size={16} aria-hidden="true" /></summary>
        <p className="heatmap-meta">ADX는 14기간 Wilder 방식으로 추세 강도를, +DI와 −DI는 방향을 나타냅니다. 장기·중기 추세가 일치하고 ADX가 25 이상이면 추세로, 중기 방향 전환과 모멘텀이 일치하고 ADX가 20 이상이면 전환 후보로 평가합니다.</p>
        <dl className="stock-detail-fields">
          <div><dt>ADX 14</dt><dd>{format(dmi.adx)}</dd></div>
          <div><dt>+DI 14</dt><dd>{format(dmi.plus)}</dd></div>
          <div><dt>−DI 14</dt><dd>{format(dmi.minus)}</dd></div>
          <div><dt>SMA 20 기울기</dt><dd>{format(sma20Slope)}{sma20Slope !== null && ` ${unit} / 거래일`}</dd></div>
          <div><dt>SMA 50/200 배열</dt><dd>{sma[50] === null || sma[200] === null ? '자료 부족' : sma[50] > sma[200] ? '50 > 200' : sma[50] < sma[200] ? '50 < 200' : '같음'}</dd></div>
          <div><dt>최근 실제 교차</dt><dd>{cross.lastEvent
            ? <>{cross.lastEvent.type === 'golden' ? '골든크로스' : '데드크로스'} · <time dateTime={cross.lastEvent.tradingDate}>{cross.lastEvent.tradingDate}</time></>
            : '확인된 교차 없음'}</dd></div>
        </dl>
      </details>
      <details>
        <summary>변동성 · 거래량 <ChevronDown size={16} aria-hidden="true" /></summary>
        <p className="heatmap-meta">ATR은 14개 진폭의 평균으로 시작해 Wilder 방식으로 갱신합니다. 볼린저밴드는 20개 종가의 모표준편차에 2를 곱합니다. 5일·20일 이동평균에는 기준일 봉을 포함합니다. 상대 거래량의 기준 평균은 당일을 제외한 직전 20개 확정 봉입니다.</p>
        <dl className="stock-detail-fields">
          <div><dt>ATR 14</dt><dd>{format(atr14)}</dd></div>
          <div><dt>볼린저 상단</dt><dd>{format(bands?.upper)}</dd></div>
          <div><dt>볼린저 중심</dt><dd>{format(bands?.middle)}</dd></div>
          <div><dt>볼린저 하단</dt><dd>{format(bands?.lower)}</dd></div>
          <div><dt>%B</dt><dd>{bands?.percentB == null ? '산출 불가' : format(bands.percentB) + '%'}</dd></div>
          <div><dt>밴드 폭</dt><dd>{bands?.bandwidth == null ? '자료 부족' : format(bands.bandwidth) + '%'}</dd></div>
          <div><dt>거래량 평균 5 / 20</dt><dd>{index && volume.latest === 0 ? '미제공' : [format(volume.sma5), format(indicators.volumeSma20)].join(' / ')}</dd></div>
          <div><dt>직전 20거래일 대비</dt><dd>{volume.ratio === null ? '비교 불가' : format(volume.ratio) + '배'}<small>급증 기준 {format(volume.spikeThreshold)}배</small></dd></div>
        </dl>
      </details>
    </div>
  </>
}
