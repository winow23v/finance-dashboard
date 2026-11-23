import { ChevronDown } from 'lucide-react'
import { useId, useMemo, useState } from 'react'
import { buildTechnicalScenarios, calculateRewardRisk, referenceRewardRisk, stopAtrBuffer } from '../services/technicalScenarios'
import type { assessTechnicalTrend, PriceZone } from '../services/technicalAssessment'
import type { TechnicalIndicators } from '../services/technicalIndicators'

const number = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 4 })
const format = (value?: number | null) => value == null ? '자료 부족' : number.format(value)
const zone = (value: PriceZone, unit: string) => `${format(value.low)} ~ ${format(value.high)} ${unit}`

const entryLabels = {
  unavailable: '분석 불가', watch: '관망', chase: '추격매수 주의', pullback: '눌림목 대기', breakout: '돌파 확인 대기',
}
const holdingLabels = {
  unavailable: '분석 불가', broken: '기존 지지 구간 하단을 확정 종가로 이탈',
  weakening: '하락 추세 또는 하락 전환 주의', intact: '상승 방향 유지 또는 전환 후보', mixed: '추세 확인 대기',
}
const priceFields = [
  ['entry', '진입 가격'], ['stop', '손절 후보 가격'], ['target', '목표 가격'],
] as const

function RewardRiskForm({ prices, unit }: {
  prices: ReturnType<typeof buildTechnicalScenarios>['entry']['prices']; unit: string
}) {
  const id = useId()
  const [values, setValues] = useState({ entry: '', stop: '', target: '' })
  const [checked, setChecked] = useState(false)
  const result = checked && calculateRewardRisk({
    entry: Number(values.entry), stop: Number(values.stop), target: Number(values.target),
  })
  return <details className="scenario-calculator">
    <summary>예상 손익비 직접 계산 <ChevronDown size={16} aria-hidden="true" /></summary>
    <form onSubmit={event => { event.preventDefault(); setChecked(true) }}>
      <div className="scenario-inputs">
        {priceFields.map(([name, label]) => <label key={name} htmlFor={id + name}>{label} ({unit})
          <input id={id + name} type="number" inputMode="decimal" step="any" value={values[name]}
            onChange={event => { setValues(previous => ({ ...previous, [name]: event.target.value })); setChecked(false) }} />
        </label>)}
      </div>
      <div className="scenario-actions">
        {prices && <button type="button" className="button" onClick={() => {
          setValues({ entry: String(prices.entry), stop: String(prices.stop), target: String(prices.target) })
          setChecked(false)
        }}>분석 후보 불러오기</button>}
        <button className="button" type="submit">손익비 계산</button>
      </div>
      <p className="heatmap-meta">세 가격에 같은 통화와 가격 기준을 사용하세요. 수수료, 세금, 슬리피지는 반영하지 않습니다.</p>
      <p aria-live="polite">{result
        ? `${format(result.ratio)}:1 · 단위당 예상 수익 ${format(result.reward)} / 위험 ${format(result.risk)} ${unit}`
        : checked ? '계산 가능한 양수 가격을 입력하세요. 손절 가격 < 진입 가격 < 목표 가격 순서여야 합니다.' : ''}</p>
    </form>
  </details>
}

export function TechnicalScenarios({ assessment, indicators, unit, stale }: {
  assessment: ReturnType<typeof assessTechnicalTrend>; indicators: TechnicalIndicators; unit: string; stale: boolean
}) {
  const id = useId()
  const [perspective, setPerspective] = useState<'entry' | 'holding'>('entry')
  const { entry, holding } = useMemo(() => buildTechnicalScenarios(assessment, indicators), [assessment, indicators])
  return <section className="technical-summary technical-scenarios" aria-labelledby={id}>
    <div className="analysis-heading">
      <h3 id={id}>조건부 시나리오</h3>
      <small>기준일 <time dateTime={assessment.tradingDate}>{assessment.tradingDate}</time></small>
    </div>
    {stale && <p className="heatmap-meta">마지막 확인 일봉 기준입니다. 새 확정 일봉에서 조건을 다시 확인하세요.</p>}
    <fieldset className="scenario-perspectives">
      <legend className="sr-only">분석 관점</legend>
      <label><input type="radio" name={id + '-perspective'} checked={perspective === 'entry'}
        onChange={() => setPerspective('entry')} />신규 진입자</label>
      <label><input type="radio" name={id + '-perspective'} checked={perspective === 'holding'}
        onChange={() => setPerspective('holding')} />기존 보유자</label>
    </fieldset>
    {perspective === 'entry' ? <div className="scenario-body">
      <strong>{entryLabels[entry.mode]}</strong>
      {entry.mode === 'unavailable' ? <p>확정 일봉이 더 쌓인 뒤 추세와 가격 구간을 확인할 수 있습니다.</p> : <>
        {entry.mode === 'chase' && <p>가격 이격 또는 과열 조건이 확인됐습니다. 지지 구간을 다시 테스트할 때의 종가를 확인합니다.</p>}
        {entry.mode === 'watch' && <p>추세와 지지 확인이 더 필요합니다. 이 상태에서는 진입 후보를 산출하지 않습니다.</p>}
        {entry.support && <p>눌림 확인 · {zone(entry.support, unit)}에서 반응하고 확정 종가가 구간 상단을 회복하는 경우</p>}
        {entry.breakoutZone && <p>돌파 확인 · {zone(entry.breakoutZone, unit)}의 상단을 확정 종가로 넘고,
          거래량이 직전 20봉 평균의 {format(entry.volumeThreshold)}배 이상인 경우
          {entry.breakoutPassed && ' · 기준일 충족, 후속 유지 여부 확인'}</p>}
        {entry.candidate && <dl className="stock-detail-fields">
          <div><dt>{entry.mode === 'breakout' ? '돌파 후 재시험 구간' : '눌림 후보 구간'}</dt><dd>{zone(entry.candidate, unit)}</dd></div>
          {entry.prices && <div><dt>손익비 계산 기준 진입가</dt><dd>{format(entry.prices.entry)} {unit}<small>후보 구간 중간값</small></dd></div>}
          <div><dt>손절 · 가설 무효화 후보</dt><dd>{entry.stop === null ? '자료 부족' : `${format(entry.stop)} ${unit}`}
            {entry.stop !== null && <small>구간 하단 − {stopAtrBuffer} ATR · 확정 종가 기준</small>}</dd></div>
          <div><dt>목표 후보</dt><dd>{entry.targetZone ? `${format(entry.targetZone.low)} ${unit}` : '상위 저항 미확인'}</dd></div>
          <div><dt>예상 손익비</dt><dd>{entry.rewardRisk ? `${format(entry.rewardRisk.ratio)}:1` : '계산 불가'}
            {entry.rewardRisk && <small>구간 중간값 진입 가정 · 참고 {referenceRewardRisk}:1 {entry.rewardRisk.ratio >= referenceRewardRisk ? '이상' : '미만'}</small>}</dd></div>
        </dl>}
        {entry.rewardRisk && <p className="heatmap-meta">예상 손익비에는 수수료, 세금, 슬리피지가 반영되지 않습니다.</p>}
      </>}
    </div> : <div className="scenario-body">
      <strong>{holdingLabels[holding.state]}</strong>
      {holding.state !== 'unavailable' && <>
        {holding.brokenSupport && <p>이탈 확인 · {zone(holding.brokenSupport, unit)}</p>}
        <dl className="stock-detail-fields">
          <div><dt>단기 위험 관리</dt><dd>{holding.shortStop === null ? '자료 부족' : `${format(holding.shortStop)} ${unit}`}
            {holding.shortLevel !== undefined && <small>가까운 지지 기준 {format(holding.shortLevel)} {unit} · {holding.shortBreached ? '기준일 종가가 위험 관리가 이하' : '하향 이탈 시 재검토'}</small>}</dd></div>
          <div><dt>중기 위험 관리</dt><dd>{holding.mediumStop === null ? '자료 부족' : `${format(holding.mediumStop)} ${unit}`}
            {holding.mediumLevel !== undefined && <small>하위 지지 또는 SMA 50 {format(holding.mediumLevel)} {unit} · {holding.mediumBreached ? '기준일 종가가 위험 관리가 이하' : '하향 이탈 시 재검토'}</small>}</dd></div>
        </dl>
        <p className="heatmap-meta">표시한 위험 관리 가격은 기준 가격에서 {stopAtrBuffer} ATR을 뺀 값입니다. 확정 종가를 기준으로 점검합니다.</p>
        <p>분할 익절 후보 · {holding.trimZones.length ? holding.trimZones.map(level => zone(level, unit)).join(' / ') : '상위 저항 미확인'}</p>
        <p>추가 매수 검토 · {holding.addSupport
          ? `${zone(holding.addSupport, unit)}에서 지지를 확인하고 확정 종가가 상단을 회복하는 경우`
          : '추세 개선과 지지 회복 확인 대기'}</p>
      </>}
    </div>}
    <RewardRiskForm prices={entry.prices} unit={unit} />
  </section>
}
