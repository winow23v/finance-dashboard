import { isNumber, isRecord } from '../services/apiFinanceService'
import { usePublicData } from '../services/usePublicData'

const indicators = [
  { id: 'base-rate', name: '한국은행 기준금리', agency: '한국은행', url: 'https://www.bok.or.kr/portal/singl/baseRate/list.do?menuNo=200656' },
  { id: 'cpi', name: '소비자물가지수', agency: '국가데이터처', url: 'https://kosis.kr/visual/economyBoard/economyDash.do' },
  { id: 'unemployment', name: '실업률 (원계열)', agency: '국가데이터처', url: 'https://kosis.kr/visual/economyBoard/economyDash.do' },
]
const timestamp = new Intl.DateTimeFormat('ko-KR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Seoul' })

function parseIndicators(value: unknown) {
  if (!isRecord(value) || !Array.isArray(value.indicators)) throw new Error('Invalid ECOS response')
  return value.indicators.map((item: unknown) => {
    if (!isRecord(item) || typeof item.id !== 'string') throw new Error('Invalid ECOS indicator')
    if (item.status === 'unavailable') return { id: item.id, code: item.code }
    if (item.status !== 'published' || !isNumber(item.value) || typeof item.unit !== 'string' || (typeof item.observationDate !== 'string' && typeof item.observationPeriod !== 'string')
      || (item.releaseDate !== null && typeof item.releaseDate !== 'string')
      || typeof item.collectedAt !== 'string' || !Number.isFinite(Date.parse(item.collectedAt))) throw new Error('Invalid ECOS observation')
    return { id: item.id, value: item.value, unit: item.unit, observationDate: item.observationDate,
      observationPeriod: item.observationPeriod, releaseDate: item.releaseDate, collectedAt: item.collectedAt }
  })
}

export function KoreaEconomy({ revision }: { revision: number }) {
  const result = usePublicData('/api/v1/economy/korea', revision, parseIndicators)
  const data = result?.data
  return <section className="market-sections" aria-label="한국 경제지표">
    <div className="section-heading"><h2>한국 경제지표</h2><a className="badge" href="https://ecos.bok.or.kr/">한국은행 ECOS</a></div>
    <div className="quote-grid">
      {indicators.map(({ id, name, agency, url }) => {
        const row = data?.find(item => item.id === id)
        return <article className="panel quote-card" key={id}>
          <div className="quote-label"><h3>{name}</h3>{row?.value !== undefined && <span>공표 통계</span>}</div>
          <strong>{row?.value !== undefined ? `${row.value.toLocaleString('ko-KR')} ${row.unit}` : data === undefined ? '조회 중' : data === null || row?.code ? '조회 불가' : '공표 관측값 없음'}</strong>
          <small>출처 <a href={url}>{agency}</a></small>
          {row?.collectedAt && <>
            <small>{row.observationDate ? `관측일 ${row.observationDate}` : `관측월 ${row.observationPeriod}`} · 발표일 {row.releaseDate ?? '미확인'}</small>
            <small>수집 (KST) <time dateTime={row.collectedAt}>{timestamp.format(new Date(row.collectedAt))}</time></small>
          </>}
        </article>
      })}
    </div>
  </section>
}
