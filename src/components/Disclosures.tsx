import { useEffect, useId, useRef, useState } from 'react'
import { isNumber, isRecord } from '../services/apiFinanceService'
import { createRequestCache } from '../services/requestCache'
import { guestPreferences } from '../storage/guestStorage'
import { usePublicData } from '../services/usePublicData'

const sources = {
  KR: { name: '금융감독원 OPEN DART', url: 'https://opendart.fss.or.kr/' },
  US: { name: 'SEC EDGAR', url: 'https://www.sec.gov/search-filings' },
}
const metricNames = { revenue: '매출액', operatingIncome: '영업이익', netIncome: '당기순이익' }
const periods = { annual: '연간', q1: '1분기', half: '반기', q3: '3분기', quarter: '분기' }
const statements = { consolidated: '연결', separate: '별도', 'entity-wide': '기업 전체' }
const number = new Intl.NumberFormat('ko-KR')
const initialResultCount = 10
const secCooldownMs = 60 * 60_000

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
  return { companies: value.companies, total: Number.isSafeInteger(value.total) && Number(value.total) >= value.companies.length ? Number(value.total) : undefined }
}
function parseDetail(value: unknown) {
  if (!isRecord(value) || !company(value.company) || !Array.isArray(value.filings) || !value.filings.every(filing)
    || !Array.isArray(value.financials) || !value.financials.every(financial)) throw new Error('Invalid disclosures')
  return { company: value.company, filings: value.filings, financials: value.financials,
    filingsError: typeof value.filingsError === 'string',
    financialsError: typeof value.financialsError === 'string' }
}

const searchCache = createRequestCache<ReturnType<typeof parseSearch>>(24, 5 * 60_000)
const detailCache = createRequestCache<ReturnType<typeof parseDetail>>(16, 5 * 60_000)
const storageKey = 'finance.dart'
const reportPeriods = ['annual', 'q1', 'half', 'q3'] as const

function restoredDart() {
  const stored = guestPreferences.load(storageKey)
  const value = isRecord(stored) ? stored : {}
  const dartCompany = (item: unknown): item is Company => company(item) && item.id.length === 8
  const page = (item: unknown) => typeof item === 'number' && Number.isInteger(item) ? Math.min(100000, Math.max(1, item)) : 1
  const currentYear = new Date().getFullYear()
  return {
    term: typeof value.term === 'string' ? value.term.slice(0, 64) : '',
    search: typeof value.search === 'string' ? value.search.trim().slice(0, 64) : '',
    selected: dartCompany(value.selected) ? value.selected : undefined,
    year: typeof value.year === 'string' && /^\d{4}$/.test(value.year) && Number(value.year) >= 2015 && Number(value.year) <= currentYear ? value.year : String(currentYear - 1),
    period: reportPeriods.find(period => period === value.period) ?? 'annual',
    searchPage: page(value.searchPage),
    filingPage: page(value.filingPage),
    recent: Array.isArray(value.recent) ? value.recent.filter(dartCompany).slice(0, 5) : [],
  }
}

function Pager({ label, page, totalPages, controls, onChange }: {
  label: string; page: number; totalPages: number; controls: string; onChange: (page: number) => void
}) {
  const status = useRef<HTMLSpanElement>(null)
  if (totalPages < 2) return null
  const move = (next: number) => {
    onChange(next)
    status.current?.focus()
  }
  return <nav className="list-pagination" aria-label={label}>
    <button type="button" className="button" aria-controls={controls} disabled={page <= 1} onClick={() => move(page - 1)}>이전</button>
    <span ref={status} role="status" tabIndex={-1}>{page} / {totalPages} 페이지</span>
    <button type="button" className="button" aria-controls={controls} disabled={page >= totalPages} onClick={() => move(page + 1)}>다음</button>
  </nav>
}

function compactWon(value: string | number) {
  if (typeof value === 'number' && !Number.isInteger(value)) return number.format(value) + '원'
  const amount = BigInt(value)
  const magnitude = amount < 0n ? -amount : amount
  if (magnitude < 100_000_000n) return number.format(amount) + '원'
  const trillions = magnitude / 1_000_000_000_000n
  const billions = magnitude / 100_000_000n % 10_000n
  return (amount < 0n ? '−' : '') + [
    trillions && number.format(trillions) + '조',
    billions && number.format(billions) + '억',
  ].filter(Boolean).join(' ') + ' 원'
}

export function Disclosures({ market, revision }: { market: keyof typeof sources; revision: number }) {
  const domestic = market === 'KR'
  const path = `/api/v1/disclosures/${market.toLowerCase()}`
  const [restored] = useState(() => domestic ? restoredDart() : undefined)
  const [term, setTerm] = useState(restored?.term ?? '')
  const [search, setSearch] = useState(restored?.search ?? '')
  const [lastCompany, setLastCompany] = useState<Company | undefined>(restored?.selected)
  const [showDetail, setShowDetail] = useState(!!restored?.selected)
  const selected = showDetail ? lastCompany : undefined
  const [searchEnabled, setSearchEnabled] = useState(!domestic)
  const [detailEnabled, setDetailEnabled] = useState(!domestic)
  const [searchPage, setSearchPage] = useState(restored?.searchPage ?? 1)
  const [filingPage, setFilingPage] = useState(restored?.filingPage ?? 1)
  const [recent, setRecent] = useState<Company[]>(restored?.recent ?? [])
  const [fullAmounts, setFullAmounts] = useState(false)
  const filingsId = useId()
  const companyHeading = useRef<HTMLHeadingElement>(null)
  const resultsId = useId()
  const secBlockedUntil = useRef(0)
  const [year, setYear] = useState(restored?.year ?? String(new Date().getFullYear() - 1))
  const [period, setPeriod] = useState<string>(restored?.period ?? 'annual')
  const [searchAttempt, setSearchAttempt] = useState(0)
  const [detailAttempt, setDetailAttempt] = useState(0)
  const timeoutMs = domestic ? 30_000 : undefined
  const searchQuery = search && searchEnabled ? new URLSearchParams({ q: search }) : undefined
  if (domestic && searchPage > 2) searchQuery?.set('page', String(searchPage))
  const searchPath = searchQuery ? path + '?' + searchQuery : undefined
  const searchResult = usePublicData(searchPath, searchAttempt, parseSearch, timeoutMs, false, domestic ? searchCache : undefined)
  const detailCompany = domestic ? detailEnabled && selected : lastCompany
  const detailQuery = detailCompany && (domestic ? { corpCode: detailCompany.id, year, period } : { cik: detailCompany.id })
  const detailPath = detailQuery ? path + '?' + new URLSearchParams(Object.entries(detailQuery)) : undefined
  const detailResult = usePublicData(detailPath, detailAttempt + (domestic ? revision : 0), parseDetail, timeoutMs, false, domestic ? detailCache : undefined)
  const companies = searchResult?.data?.companies
  const detail = detailResult?.data
  const [lastTotal, setLastTotal] = useState<{ search: string; total: number }>()
  const searchTotal = searchResult?.data?.total ?? (lastTotal?.search === search ? lastTotal?.total : companies?.length ?? 0)
  useEffect(() => {
    if (searchResult?.data?.total !== undefined) {
      const total = searchResult.data.total
      setLastTotal(previous => previous?.search === search && previous.total === total ? previous : { search, total })
    }
  }, [search, searchResult?.data?.total])
  useEffect(() => {
    if (domestic) guestPreferences.save(storageKey, { term, search, selected, year, period, searchPage, filingPage, recent })
  }, [domestic, term, search, selected, year, period, searchPage, filingPage, recent])
  const restrictedResult = searchResult?.errorCode === 'SEC_ACCESS_RESTRICTED' ? searchResult
    : detailResult?.errorCode === 'SEC_ACCESS_RESTRICTED' ? detailResult : undefined
  const unavailable = restrictedResult ? '조회 불가 · SEC EDGAR 공급자 접근 제한' : '조회 불가'
  const source = sources[market]
  useEffect(() => {
    if (restrictedResult) secBlockedUntil.current = Date.now() + secCooldownMs
  }, [restrictedResult])
  const secBlocked = () => !domestic && Date.now() < secBlockedUntil.current
  const searchPages = Math.max(1, Math.ceil(searchTotal / initialResultCount))
  const visibleCompanies = domestic && searchPage <= 2 ? companies?.slice((searchPage - 1) * initialResultCount, searchPage * initialResultCount) : companies
  const filings = detail?.filings ?? []
  const filingPages = 1 + Math.ceil(Math.max(0, filings.length - 5) / 10)
  const shownFilingPage = Math.min(filingPage, filingPages)
  const filingOffset = shownFilingPage === 1 ? 0 : 5 + (shownFilingPage - 2) * 10
  const visibleFilings = domestic ? filings.slice(filingOffset, filingOffset + (shownFilingPage === 1 ? 5 : 10)) : filings

  function openCompany(item: Company, restorePage = false) {
    if (secBlocked() && item.id !== lastCompany?.id) return
    if (domestic) {
      setDetailEnabled(true)
      if (!restorePage && item.id !== lastCompany?.id) setFilingPage(1)
      setRecent(previous => [item, ...previous.filter(entry => entry.id !== item.id)].slice(0, 5))
    }
    setLastCompany(item)
    setShowDetail(true)
    requestAnimationFrame(() => companyHeading.current?.focus())
    if (!domestic && item.id === lastCompany?.id && detail === null && !secBlocked()) setDetailAttempt(value => value + 1)
  }

  return <section className="panel disclosures-panel">
    <div className="panel-heading"><div><h2>{domestic ? '국내' : '미국'} 기업 공시·재무</h2>
      <p><a href={source.url}>{source.name}</a> · 공표 자료</p></div></div>
    <form className="disclosure-controls" onSubmit={event => {
      event.preventDefault()
      const query = term.trim()
      if (!query || secBlocked()) return
      setShowDetail(false)
      setSearchEnabled(true)
      if (query === search) {
        if (searchResult?.data === null) setSearchAttempt(value => value + 1)
        return
      }
      setLastCompany(undefined)
      setSearchPage(1)
      setSearch(query)
    }}>
      <label>기업 검색 <input value={term} onChange={event => setTerm(event.target.value)} maxLength={64} required
        placeholder={domestic ? '기업명 또는 종목코드' : '기업명, 티커 또는 CIK'} /></label>
      <button className="button" type="submit">검색</button>
    </form>
    {domestic && recent.length > 0 && <div className="recent-companies" aria-label="최근 조회 기업">
      <small>최근 조회</small>
      {recent.map(item => <button type="button" className="button" key={item.id} onClick={() => openCompany(item)}>{item.name}</button>)}
    </div>}
    {search && !selected && <div>
      <div id={resultsId} aria-live="polite" aria-busy={!!searchPath && searchResult === undefined}>
        {!searchEnabled ? <p className="state">검색을 선택해 마지막 검색 결과를 불러올 수 있습니다.</p>
          : !visibleCompanies?.length ? <p className="state">{searchResult === undefined ? '조회 중' : searchResult.data === null ? unavailable : '검색 결과 없음'}</p>
          : <ul className={domestic ? 'disclosure-list company-results' : 'disclosure-list'}>
            {visibleCompanies.map(item => <li key={`${item.id}/${item.ticker}`}><button type="button" className={domestic ? 'company-result' : 'button'} onClick={() => openCompany(item)}>
              {domestic ? <><span>{item.name}</span><span className="company-code">{item.ticker ?? '종목코드 없음'}</span></> : `${item.name} · ${item.ticker ?? item.id}`}
            </button></li>)}
          </ul>}
      </div>
      {domestic && <Pager label="기업 검색 페이지" page={searchPage} totalPages={searchPages} controls={resultsId} onChange={setSearchPage} />}
    </div>}
    {selected && <>
      <div className="section-heading"><h3 ref={companyHeading} tabIndex={-1}>{selected.name} · {selected.ticker ?? selected.id}</h3><button className="button" onClick={() => setShowDetail(false)}>검색 결과</button></div>
      {domestic && <div className="disclosure-controls">
        <label>사업연도 <select value={year} onChange={event => { setYear(event.target.value); setDetailEnabled(true) }}>
          {Array.from({ length: new Date().getFullYear() - 2014 }, (_, i) => new Date().getFullYear() - i)
            .map(value => <option key={value}>{value}</option>)}
        </select></label>
        <label>보고기간 <select value={period} onChange={event => { setPeriod(event.target.value); setDetailEnabled(true) }}>
          {reportPeriods.map(value => <option key={value} value={value}>{periods[value]}</option>)}
        </select></label>
      </div>}
      {domestic && !detailEnabled ? <button type="button" className="button" onClick={() => openCompany(selected, true)}>공시·재무 조회</button> : !detail ? <div className="state"><p role="status">{detail === undefined ? '조회 중' : unavailable}</p>
        {detail === null && !restrictedResult && <button className="button" onClick={() => {
          if (!secBlocked()) setDetailAttempt(value => value + 1)
        }}>다시 시도</button>}</div> : <>
        <h3>최근 공시</h3>
        <ul id={filingsId} className="disclosure-list">{visibleFilings.map(item => <li key={item.id}>
          <a href={item.url}>{item.title}</a> · 공시일 {item.filedAt}{item.reportEnd && ` · 결산일 ${item.reportEnd}`}{item.amended && ' · 정정'}
        </li>)}</ul>
        {domestic && <Pager label="최근 공시 페이지" page={shownFilingPage} totalPages={filingPages} controls={filingsId} onChange={setFilingPage} />}
        {!detail.filings.length && <p className="state">{detail.filingsError ? '최근 공시 조회 불가' : '조회 기간에 공시 없음'}</p>}
        <h3>주요 재무정보</h3>
        {domestic && detail.financials.some(row => row.unit === 'KRW') && <label className="amount-display">
          <input type="checkbox" checked={fullAmounts} onChange={event => setFullAmounts(event.target.checked)} /> 원 단위 전체 금액
        </label>}
        {!!detail.financials.length && <div className="disclosure-table"><table>
          <thead><tr><th scope="col">항목</th><th scope="col">구분</th><th scope="col">보고기간</th><th scope="col">금액</th></tr></thead>
          <tbody>{detail.financials.map(row => {
            const report = detail.filings.find(item => item.id === row.filingId)
            const reportUrl = report?.url ?? (domestic && /^\d{14}$/.test(row.filingId)
              ? `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${row.filingId}` : undefined)
            const label = `${row.year ?? `${row.start} ~ ${row.end}`} · ${periods[row.period]}${row.basis === 'year-to-date' ? ' 누적' : row.basis === 'current-period' ? ' 당기' : ''}`
            return <tr key={`${row.filingId}/${row.statement}/${row.metric}`}>
              <td>{metricNames[row.metric]}</td><td>{statements[row.statement]}</td>
              <td>{reportUrl ? <a href={reportUrl}>{label}</a> : label}{domestic && row.end && ` · 기간 종료일 ${row.end}`}{report?.amended && ' · 정정'}</td>
              <td>{domestic && row.unit === 'KRW' ? (fullAmounts ? number.format(typeof row.value === 'string' ? BigInt(row.value) : row.value) + '원' : compactWon(row.value)) : number.format(typeof row.value === 'string' ? BigInt(row.value) : row.value) + ' ' + row.unit}</td>
            </tr>
          })}</tbody>
        </table></div>}
        {!detail.financials.length && <p className="state">{detail.financialsError ? '재무정보 조회 불가' : '선택한 보고기간의 재무자료 없음'}</p>}
        {domestic && (detail.filingsError || detail.financialsError) && <button type="button" className="button"
          onClick={() => setDetailAttempt(value => value + 1)}>공시·재무 다시 시도</button>}
      </>}
    </>}
  </section>
}
