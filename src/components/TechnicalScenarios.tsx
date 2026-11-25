import { X } from 'lucide-react'
import { useId, useRef, useState } from 'react'
import { calculateRewardRisk, referenceRewardRisk, stopAtrBuffer, type buildTechnicalScenarios, type ScenarioPrices } from '../services/technicalScenarios'
import { displayScenarioPrices, formatAnalysisPrice, formatMetric as format, formatThreshold, formatZone, pricePolicy, type PriceDisplay } from '../services/analysisPrices'

export const entryLabels = {
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
  prices: ScenarioPrices | null; unit: PriceDisplay['unit']
}) {
  const id = useId()
  const drawer = useRef<HTMLDialogElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const [values, setValues] = useState({ entry: '', stop: '', target: '' })
  const [checked, setChecked] = useState(false)
  const [source, setSource] = useState<'manual' | 'analysis'>('manual')
  const [confirmImport, setConfirmImport] = useState(false)
  function loadPrices() {
    if (!prices) return
    setValues({ entry: String(prices.entry), stop: String(prices.stop), target: String(prices.target) })
    setChecked(false)
    setSource('analysis')
    setConfirmImport(false)
  }
  const result = checked && calculateRewardRisk({
    entry: Number(values.entry), stop: Number(values.stop), target: Number(values.target),
  })
  return <div className="scenario-calculator">
    <button ref={trigger} className="button" type="button" aria-haspopup="dialog" aria-controls={id + '-drawer'}
      onClick={() => drawer.current?.showModal()}>예상 손익비 직접 계산</button>
    <dialog ref={drawer} id={id + '-drawer'} className="panel scenario-drawer" aria-labelledby={id + '-title'}
      onClose={() => trigger.current?.focus({ preventScroll: true })}
      onClick={event => { if (event.target === event.currentTarget) event.currentTarget.close() }}>
      <div className="scenario-drawer-content">
        <div className="section-heading"><h3 id={id + '-title'}>예상 손익비 직접 계산</h3>
          <button className="icon-button" type="button" aria-label="계산기 닫기" onClick={() => drawer.current?.close()}><X size={18} /></button>
        </div>
        <form onSubmit={event => { event.preventDefault(); setChecked(true) }}>
          <div className="scenario-inputs">
            {priceFields.map(([name, label]) => <label key={name} htmlFor={id + name}>{label} ({unit})
              <input id={id + name} type="number" inputMode="decimal" step="any" autoComplete="off" value={values[name]}
                onChange={event => { setValues(previous => ({ ...previous, [name]: event.target.value })); setChecked(false); setSource('manual'); setConfirmImport(false) }} />
            </label>)}
          </div>
          <div className="scenario-actions">
            {prices && !confirmImport && <button type="button" className="button"
              onClick={() => Object.values(values).some(value => value !== '') ? setConfirmImport(true) : loadPrices()}>
              분석 후보 불러오기
            </button>}
            {confirmImport && <>
              <button type="button" className="button" onClick={loadPrices}>입력값을 분석 후보로 교체</button>
              <button type="button" className="button" onClick={() => setConfirmImport(false)}>기존 입력 유지</button>
            </>}
            <button className="button" type="submit">손익비 계산</button>
          </div>
          {confirmImport && <p role="status">기존 입력값을 현재 화면의 분석 후보로 바꿀까요?</p>}
          <p className="heatmap-meta">{source === 'analysis' ? '입력 기준 · 화면에 표시한 분석 후보' : '입력 기준 · 직접 입력'}</p>
          <p className="heatmap-meta">참고 손익비 {referenceRewardRisk}:1. 세 가격에 같은 통화와 가격 기준을 사용하세요. 수수료, 세금, 슬리피지는 반영하지 않습니다.</p>
          <p aria-live="polite">{result
            ? `${format(result.ratio)}:1 · 단위당 예상 수익 ${format(result.reward)} ${unit} / 예상 위험 ${format(result.risk)} ${unit}`
            : checked ? '계산 가능한 양수 가격을 입력하세요. 손절 가격 < 진입 가격 < 목표 가격 순서여야 합니다.' : ''}</p>
        </form>
      </div>
    </dialog>
  </div>
}

export function TechnicalScenarios({ plan, tradingDate, display, stale }: {
  plan: ReturnType<typeof buildTechnicalScenarios>; tradingDate: string; display: PriceDisplay; stale: boolean
}) {
  const id = useId()
  const [perspective, setPerspective] = useState<'entry' | 'holding'>('entry')
  const { entry, holding } = plan
  const shown = displayScenarioPrices({ entry: entry.entryPrice, stop: entry.stop, target: entry.targetZone?.low ?? null }, display)
  const rewardRisk = shown.prices && calculateRewardRisk(shown.prices)
  const { unit } = display
  const zone = (value: Parameters<typeof formatZone>[0]) => formatZone(value, display)
  const down = (value?: number | null) => formatThreshold(value, display)
  return <section className="technical-summary technical-scenarios" aria-labelledby={id}>
    <div className="analysis-heading">
      <h3 id={id}>조건부 시나리오</h3>
      <small>기준일 <time dateTime={tradingDate}>{tradingDate}</time></small>
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
      <strong>{entry.mode === 'breakout' && entry.breakoutPassed ? '신규 진입 검토 · 재시험 대기' : entryLabels[entry.mode]}</strong>
      {entry.mode === 'unavailable' ? <p>확정 일봉이 더 쌓인 뒤 추세와 가격 구간을 확인할 수 있습니다.</p> : <>
        {entry.mode === 'chase' && <p>가격 이격 또는 과열 조건이 확인됐습니다. 지지 구간을 다시 테스트할 때의 종가를 확인합니다.</p>}
        {entry.mode === 'watch' && <p>추세와 지지 확인이 더 필요합니다. 이 상태에서는 진입 후보를 산출하지 않습니다.</p>}
        {(entry.support || entry.breakoutZone) && <dl className="scenario-conditions">
          {entry.support && <div><dt>눌림 확인</dt><dd><strong>{zone(entry.support)}</strong><small>지지 반응 뒤 확정 종가가 구간 상단을 회복</small></dd></div>}
          {entry.breakoutZone && <div><dt>돌파 확인</dt><dd><strong>{zone(entry.breakoutZone)}</strong>
            <small>종가 상단 돌파 · 거래량 직전 20봉 평균의 {format(entry.volumeThreshold)}배 이상</small>
            {entry.breakoutPassed && <small>기준일 충족 · 후속 유지 확인</small>}</dd></div>}
        </dl>}
        {entry.candidate && <>
          <p className="heatmap-meta">{pricePolicy(display)} · 주문 및 체결 가격은 거래 화면에서 확인하세요.</p>
          <dl className="stock-detail-fields scenario-price-cards">
            <div><dt>진입 후보</dt><dd>{zone(entry.candidate)}
              <small>{entry.mode === 'breakout' ? '돌파 후 재시험' : '눌림 확인'} · 손익비 기준가 {formatAnalysisPrice(shown.entry, unit)}</small></dd></div>
            <div><dt>손절 · 가설 무효화 후보</dt><dd>{formatAnalysisPrice(shown.stop, unit)}
              {shown.stop !== null && <small>구간 하단 − {stopAtrBuffer} ATR · 확정 종가 기준</small>}</dd></div>
            <div><dt>목표가 후보</dt><dd>{entry.targetZone ? formatAnalysisPrice(shown.target, unit) : '상위 저항 미확인'}
              {shown.target !== null && <small>상위 저항 구간의 하단 기준</small>}</dd></div>
            <div><dt>예상 손익비</dt><dd>{rewardRisk ? `${format(rewardRisk.ratio)}:1` : '계산 불가'}
              {rewardRisk ? <small>표시 후보 기준 · 참고 {referenceRewardRisk}:1 {rewardRisk.ratio >= referenceRewardRisk ? '이상' : '미만'}</small>
                : shown.prices && <small>표시 가격을 보정한 뒤 손절가·진입가·목표가 순서가 성립하지 않습니다.</small>}</dd></div>
          </dl>
          <p className="heatmap-meta">진입 기준가는 올리고 손절·목표 후보는 내립니다. 손익비에는 수수료, 세금, 슬리피지가 반영되지 않습니다.</p>
        </>}
      </>}
    </div> : <div className="scenario-body">
      <strong>{holdingLabels[holding.state]}</strong>
      {holding.state !== 'unavailable' && <>
        {holding.brokenSupport && <p>이탈 확인 · {zone(holding.brokenSupport)}</p>}
        <dl className="stock-detail-fields">
          <div><dt>단기 위험 관리</dt><dd>{holding.shortStop === null ? '자료 부족' : down(holding.shortStop)}
            {holding.shortLevel !== undefined && <small>가까운 지지 기준 {down(holding.shortLevel)} · {holding.shortBreached ? '기준일 종가가 위험 관리가 이하' : '하향 이탈 시 재검토'}</small>}</dd></div>
          <div><dt>중기 위험 관리</dt><dd>{holding.mediumStop === null ? '자료 부족' : down(holding.mediumStop)}
            {holding.mediumLevel !== undefined && <small>하위 지지 또는 SMA 50 {down(holding.mediumLevel)} · {holding.mediumBreached ? '기준일 종가가 위험 관리가 이하' : '하향 이탈 시 재검토'}</small>}</dd></div>
        </dl>
        <p className="heatmap-meta">표시한 위험 관리 가격은 기준 가격에서 {stopAtrBuffer} ATR을 뺀 값입니다. 확정 종가를 기준으로 점검합니다.</p>
        <dl className="scenario-conditions">
          <div><dt>분할 익절 후보</dt><dd>{holding.trimZones.length ? holding.trimZones.map(level => <strong key={level.low}>{zone(level)}</strong>) : '상위 저항 미확인'}</dd></div>
          <div><dt>추가 매수 검토</dt><dd>{holding.addSupport ? <><strong>{zone(holding.addSupport)}</strong>
            <small>지지 확인 뒤 확정 종가가 구간 상단 회복</small></> : '추세 개선과 지지 회복 확인 대기'}</dd></div>
        </dl>
      </>}
    </div>}
    <RewardRiskForm prices={rewardRisk ? shown.prices : null} unit={unit} />
  </section>
}
