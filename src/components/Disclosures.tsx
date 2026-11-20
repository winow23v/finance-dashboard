import { useState } from 'react'
import { isNumber, isRecord } from '../services/apiFinanceService'
import { usePublicData } from '../services/usePublicData'

const sources = {
  KR: { name: '금융감독원 OPEN DART', url: 'https://opendart.fss.or.kr/' },
  US: { name: 'SEC EDGAR', url: 'https://www.sec.gov/search-filings' },
}
const metricNames = { revenue: '매출액', operatingIncome: '영업이익', netIncome: '당기순이익' }
const periods = { annual: '연간', q1: '1분기', half: '반기', q3: '3분기', quarter: '분기' }
const statements = { consolidated: '연결', separate: '별도', 'entity-wide': '기업 전체' }
const number = new Intl.NumberFormat('ko-KR')

type Company = { id: string; name: string; ticker?: string }
type Filing = { id: string; title: string; filedAt: string; reportEnd?: string; amended: boolean; url: string }
type Financial = {
  metric: keyof typeof metricNames; statement: keyof typeof statements; period: keyof typeof periods
  value: string | number; unit: string; filingId: string; year?: string; start?: string; end?: string; basis?: string
}

function company(value: unknown): value is Company {
  return isRecord(value) && typeof value.id === 'string' && /^\d{8,10}$/.test(value.id)
    && typeof value.name === 'string' && (value.ticker === undefined || typeof value.ticker === 'string')
}

function filing(value: unknown): value is Filing {
  return isRecord(value) && typeof value.id === 'string' && typeof value.title === 'string'
    && typeof value.filedAt === 'string' && (value.reportEnd === undefined || typeof value.reportEnd === 'string')
    && typeof value.amended === 'boolean' && typeof value.url === 'string'
    && (/^https:\/\/dart\.fss\.or\.kr\/dsaf001\/main\.do\?rcpNo=\d{14}$/.test(value.url)
      || /^https:\/\/www\.sec\.gov\/Archives\/edgar\/data\/\d+\/\d{18}\/[\w.-]+\.(?:html?|txt)$/i.test(value.url))
}

function financial(value: unknown): value is Financial {
  return isRecord(value) && typeof value.metric === 'string' && Object.hasOwn(metricNames, value.metric)
    && typeof value.period === 'string' && Object.hasOwn(periods, value.period)
    && typeof value.statement === 'string' && Object.hasOwn(statements, value.statement)
    && (isNumber(value.value) || (typeof value.value === 'string' && /^-?\d+$/.test(value.value)))
    && typeof value.unit === 'string' && /^[A-Z]{3}$/.test(value.unit) && typeof value.filingId === 'string'
    && (value.year === undefined || typeof value.year === 'string')
    && (value.start === undefined || typeof value.start === 'string')
    && (value.end === undefined || typeof value.end === 'string')
    && (value.basis === undefined || typeof value.basis === 'string')
}

function parseSearch(value: unknown) {
  if (!isRecord(value) || !Array.isArray(value.companies) || !value.companies.every(company)) throw new Error('Invalid company search')
  return value.companies
}
function parseDetail(value: unknown) {
  if (!isRecord(value) || !company(value.company) || !Array.isArray(value.filings) || !value.filings.every(filing)
    || !Array.isArray(value.financials) || !value.financials.every(financial)) throw new Error('Invalid disclosures')
  return { company: value.company, filings: value.filings, financials: value.financials,
    filingsError: typeof value.filingsError === 'string',
    financialsError: typeof value.financialsError === 'string' }
}

export function Disclosures({ market, revision }: { market: keyof typeof sources; revision: number }) {
  const domestic = market === 'KR'
  const path = `/api/v1/disclosures/${market.toLowerCase()}`
  const [term, setTerm] = useState('')
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<Company>()
  const [year, setYear] = useState(String(new Date().getFullYear() - 1))
  const [period, setPeriod] = useState('annual')
  const [attempt, setAttempt] = useState(0)
  const requestRevision = domestic ? revision + attempt : attempt
  const timeoutMs = domestic ? 30_000 : undefined
  const searchPath = search && !selected ? path + '?' + new URLSearchParams({ q: search }) : undefined
  const searchResult = usePublicData(searchPath, requestRevision, parseSearch, timeoutMs)
  const detailQuery = selected && (domestic ? { corpCode: selected.id, year, period } : { cik: selected.id })
  const detailPath = detailQuery ? path + '?' + new URLSearchParams(Object.entries(detailQuery)) : undefined
  const detailResult = usePublicData(detailPath, requestRevision, parseDetail, timeoutMs)
  const companies = searchResult?.data
  const detail = detailResult?.data
  const accessRestricted = searchResult?.errorCode === 'SEC_ACCESS_RESTRICTED' || detailResult?.errorCode === 'SEC_ACCESS_RESTRICTED'
  const unavailable = accessRestricted ? '조회 불가 · SEC EDGAR 공급자 접근 제한' : '조회 불가'
  const source = sources[market]

  return <section className="panel disclosures-panel">
    <div className="panel-heading"><div><h2>{domestic ? '국내' : '미국'} 기업 공시·재무</h2>
      <p><a href={source.url}>{source.name}</a> · 공표 자료</p></div></div>
    <form className="disclosure-controls" onSubmit={event => {
      event.preventDefault()
      const query = term.trim()
      if (!query) return
      setSelected(undefined)
      if (query === search) setAttempt(value => value + 1)
      setSearch(query)
    }}>
      <label>기업 검색 <input value={term} onChange={event => setTerm(event.target.value)} maxLength={64} required
        placeholder={domestic ? '기업명 또는 종목코드' : '기업명, 티커 또는 CIK'} /></label>
      <button className="button" type="submit">검색</button>
    </form>
    {search && !selected && <div aria-live="polite">
      {!companies?.length ? <p className="state">{companies === undefined ? '조회 중' : companies === null ? unavailable : '검색 결과 없음'}</p>
        : <ul className="disclosure-list">{companies.map(item => <li key={`${item.id}/${item.ticker}`}><button className="button" onClick={() => setSelected(item)}>
          {item.name} · {item.ticker ?? item.id}
        </button></li>)}</ul>}
    </div>}
    {selected && <>
      <div className="section-heading"><h3>{selected.name} · {selected.id}</h3><button className="button" onClick={() => setSelected(undefined)}>검색 결과</button></div>
      {domestic && <div className="disclosure-controls">
        <label>사업연도 <select value={year} onChange={event => setYear(event.target.value)}>
          {Array.from({ length: new Date().getFullYear() - 2014 }, (_, i) => new Date().getFullYear() - i)
            .map(value => <option key={value}>{value}</option>)}
        </select></label>
        <label>보고기간 <select value={period} onChange={event => setPeriod(event.target.value)}>
          {(['annual', 'q1', 'half', 'q3'] as const).map(value => <option key={value} value={value}>{periods[value]}</option>)}
        </select></label>
      </div>}
      {!detail ? <div className="state"><p role="status">{detail === undefined ? '조회 중' : unavailable}</p>
        {detail === null && !accessRestricted && <button className="button" onClick={() => setAttempt(value => value + 1)}>다시 시도</button>}</div> : <>
        <h3>최근 공시</h3>
        <ul className="disclosure-list">{detail.filings.map(item => <li key={item.id}>
          <a href={item.url}>{item.title}</a> · 공시일 {item.filedAt}{item.reportEnd && ` · 결산일 ${item.reportEnd}`}{item.amended && ' · 정정'}
        </li>)}</ul>
        {!detail.filings.length && <p className="state">{detail.filingsError ? '최근 공시 조회 불가' : '조회 기간에 공시 없음'}</p>}
        <h3>주요 재무정보</h3>
        {!!detail.financials.length && <div className="disclosure-table"><table>
          <thead><tr><th scope="col">항목</th><th scope="col">구분</th><th scope="col">보고기간</th><th scope="col">금액</th></tr></thead>
          <tbody>{detail.financials.map(row => {
            const report = detail.filings.find(item => item.id === row.filingId)
            const reportUrl = report?.url ?? (domestic && /^\d{14}$/.test(row.filingId)
              ? `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${row.filingId}` : undefined)
            const label = `${row.year ?? `${row.start} ~ ${row.end}`} · ${periods[row.period]}${row.basis === 'year-to-date' ? ' 누적' : ''}`
            return <tr key={`${row.filingId}/${row.statement}/${row.metric}`}>
              <td>{metricNames[row.metric]}</td><td>{statements[row.statement]}</td>
              <td>{reportUrl ? <a href={reportUrl}>{label}</a> : label}{domestic && row.end && ` · 기간 종료일 ${row.end}`}{report?.amended && ' · 정정'}</td>
              <td>{number.format(typeof row.value === 'string' ? BigInt(row.value) : row.value)} {row.unit}</td>
            </tr>
          })}</tbody>
        </table></div>}
        {!detail.financials.length && <p className="state">{detail.financialsError ? '재무정보 조회 불가' : '선택한 보고기간의 재무자료 없음'}</p>}
      </>}
    </>}
  </section>
}
