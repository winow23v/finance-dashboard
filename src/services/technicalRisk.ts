import type { assessTechnicalTrend } from './technicalAssessment'
import type { TechnicalIndicators } from './technicalIndicators'

export function technicalRisk(assessment: ReturnType<typeof assessTechnicalTrend> | null,
  indicators: TechnicalIndicators | null, stale: boolean, expectVolume = true) {
  const checks = [
    { label: '지지 이탈 · 확정 종가가 직전 구간 하단 아래', signal: '주요 지지 이탈 주의',
      value: assessment?.zones.structureAvailable
        ? !!assessment.zones.breakDown : null },
    { label: '과열 · RSI 70 이상 또는 종가가 볼린저 상단 초과', signal: '과열 주의',
      value: indicators && ((indicators.rsi14 ?? 0) >= 70 || !!indicators.bands && indicators.close > indicators.bands.upper) ? true
        : indicators?.rsi14 == null || !indicators.bands ? null : false },
    { label: '이격 · 종가와 SMA20의 간격이 2 ATR 이상', signal: '이동평균 이격 주의',
      value: indicators?.sma[20] == null || !indicators.atr14 ? null
        : Math.abs(indicators.close - indicators.sma[20]) >= indicators.atr14 * 2 },
    { label: '변동성 확대 · ATR이 직전 거래일보다 25% 이상 증가', signal: '변동성 확대',
      value: !indicators?.prior.atr14 || indicators.atr14 === null ? null : indicators.atr14 >= indicators.prior.atr14 * 1.25 },
    ...(expectVolume ? [{ label: '거래량 · 상대 거래량 또는 돌파·이탈의 급증 동반 확인', signal: '거래량 확인 부족',
      value: indicators?.volume.ratio == null ? null : assessment?.breakVolumeConfirmed === false }] : []),
  ]
  const signals = checks.filter(check => check.value === true || (check.value === null && check.signal === '거래량 확인 부족'))
    .map(check => check.signal)
  const incomplete = checks.some(check => check.value === null)
  const missingCore = checks.some(check => check.value === null && check.signal !== '거래량 확인 부족')
  return { checks, signals, incomplete, status: stale ? '최신 위험 상태 확인 불가'
    : missingCore && !signals.some(signal => signal !== '거래량 확인 부족') ? '위험 분석 자료 부족'
      : signals.length ? signals.join(' · ') : '현재 감지된 주요 기술적 위험 신호 없음' }
}
