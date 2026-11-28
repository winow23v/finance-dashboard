import { formatWon } from '../services/formatWon'
import { SearchButton, useSearchComposition } from './SearchButton'
import { LoadingSkeleton } from './LoadingSkeleton'
import { useEffect, useId, useRef, useState } from 'react'
import { isNumber, isRecord } from '../services/apiFinanceService'
import { createRequestCache } from '../services/requestCache'
import { guestPreferences } from '../storage/guestStorage'
import { usePublicData } from '../services/usePublicData'

const path = '/api/v1/disclosures/kr'
const metricNames = { revenue: '매출액', operatingIncome: '영업이익', netIncome: '당기순이익' }
const periods = { annual: '연간', q1: '1분기', half: '반기', q3: '3분기', quarter: '분기' }
const statements = { consolidated: '연결', separate: '별도', 'entity-wide': '기업 전체' }
const number = new Intl.NumberFormat('ko-KR')
const initialResultCount = 10

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
    && /^https:\/\/dart\.fss\.or\.kr\/dsaf001\/main\.do\?rcpNo=\d{14}$/.test(value.url)
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
export function StockDisclosures({ symbol }: { symbol: string }) {
  const [shown, setShown] = useState(false)
  const search = usePublicData(shown ? path + '?' + new URLSearchParams({ q: symbol }) : undefined,
    0, parseSearch, 15_000, false, searchCache)
  const matches = search?.data?.companies.filter(company => company.ticker === symbol) ?? []
  const corpCode = matches.length === 1 ? matches[0].id : undefined
  const detail = usePublicData(corpCode ? path + '?' + new URLSearchParams({ corpCode }) : undefined,
    0, parseDetail, 15_000, false, detailCache)
  return <details className="technical-detail-group" onToggle={event => { if (event.currentTarget.open) setShown(true) }}>
    <summary>최근 기업 공시</summary>
    {shown && (search?.data === null || detail?.data === null || detail?.data?.filingsError
      ? <p role="status">OPEN DART 공시를 조회하지 못했습니다.</p>
      : search?.data && !corpCode ? <p role="status">이 종목과 일치하는 공시 기업이 없습니다.</p>
        : !detail?.data ? <p role="status">공시를 불러오는 중입니다.</p>
          : detail.data.filings.length === 0 ? <p role="status">최근 90일 공시가 없습니다.</p>
            : <ul className="disclosure-list">{detail.data.filings.slice(0, 5).map(filing => <li key={filing.id}>
              <a href={filing.url}>{filing.title}</a> · <time dateTime={filing.filedAt}>{filing.filedAt}</time>
              {/(?:^|\])\s*(?:주요사항보고서|사업보고서|반기보고서|분기보고서)/u.test(filing.title) && ' · 주요·정기 보고'}
              {filing.amended && ' · 정정'}
            </li>)}</ul>)}
  </details>
}

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

export function Disclosures({ revision, visible = true, onRefreshReady, onRefreshResult }: {
  revision: number; visible?: boolean; onRefreshReady?: (ready: boolean) => void; onRefreshResult?: (key: string, failed: boolean) => void
}) {
  const [restored] = useState(restoredDart)
  const [term, setTerm] = useState(restored?.term ?? '')
  const [search, setSearch] = useState(restored?.search ?? '')
  const [lastCompany, setLastCompany] = useState<Company | undefined>(restored?.selected)
  const [showDetail, setShowDetail] = useState(!!restored?.selected)
  const selected = showDetail ? lastCompany : undefined
  const [searchEnabled, setSearchEnabled] = useState(false)
  const [detailEnabled, setDetailEnabled] = useState(false)
  const [searchPage, setSearchPage] = useState(restored?.searchPage ?? 1)
  const [filingPage, setFilingPage] = useState(restored?.filingPage ?? 1)
  const [recent, setRecent] = useState<Company[]>(restored?.recent ?? [])
  const [statement, setStatement] = useState('all')
  const input = useRef<HTMLInputElement>(null)
  const { composing, inputEvents } = useSearchComposition()
  const filingsId = useId()
  const companyHeading = useRef<HTMLHeadingElement>(null)
  const resultsId = useId()
  const [year, setYear] = useState(restored?.year ?? String(new Date().getFullYear() - 1))
  const [period, setPeriod] = useState<string>(restored?.period ?? 'annual')
  const [searchAttempt, setSearchAttempt] = useState(0)
  const [detailAttempt, setDetailAttempt] = useState(0)
  const timeoutMs = 30_000
  const searchQuery = search && searchEnabled ? new URLSearchParams({ q: search }) : undefined
  if (searchPage > 2) searchQuery?.set('page', String(searchPage))
  const searchPath = searchQuery ? path + '?' + searchQuery : undefined
  const searchResult = usePublicData(searchPath, searchAttempt, parseSearch, timeoutMs, false, searchCache)
  const detailCompany = detailEnabled && lastCompany
  const detailQuery = detailCompany && { corpCode: detailCompany.id, year, period }
  const detailPath = detailQuery ? path + '?' + new URLSearchParams(Object.entries(detailQuery)) : undefined
  const detailResult = usePublicData(detailPath, detailAttempt + revision, parseDetail, timeoutMs, false, detailCache)
  const companies = searchResult?.data?.companies
  const detail = detailResult?.data
  const refreshReady = !!selected && !!detailPath && detailResult !== undefined
  useEffect(() => { onRefreshReady?.(refreshReady) }, [onRefreshReady, refreshReady])
  const refreshFailed = !detail || detail.filingsError || detail.financialsError
  useEffect(() => { if (detailResult) onRefreshResult?.('dart', refreshFailed) }, [detailResult, refreshFailed, revision, onRefreshResult])
  const [lastTotal, setLastTotal] = useState<{ search: string; total: number }>()
  const searchTotal = searchResult?.data?.total ?? (lastTotal?.search === search ? lastTotal?.total : companies?.length ?? 0)
  useEffect(() => {
    if (searchResult?.data?.total !== undefined) {
      const total = searchResult.data.total
      setLastTotal(previous => previous?.search === search && previous.total === total ? previous : { search, total })
    }
  }, [search, searchResult?.data?.total])
  useEffect(() => {
    guestPreferences.save(storageKey, { term, search, selected, year, period, searchPage, filingPage, recent })
  }, [term, search, selected, year, period, searchPage, filingPage, recent])
  const searchPages = Math.max(1, Math.ceil(searchTotal / initialResultCount))
  const visibleCompanies = searchPage <= 2 ? companies?.slice((searchPage - 1) * initialResultCount, searchPage * initialResultCount) : companies
  const financials = detail?.financials.filter(row => statement === 'all' || row.statement === statement) ?? []
  const filings = detail?.filings ?? []
  const filingPages = 1 + Math.ceil(Math.max(0, filings.length - 5) / 10)
  const shownFilingPage = Math.min(filingPage, filingPages)
  const filingOffset = shownFilingPage === 1 ? 0 : 5 + (shownFilingPage - 2) * 10
  const visibleFilings = filings.slice(filingOffset, filingOffset + (shownFilingPage === 1 ? 5 : 10))

  function openCompany(item: Company, restorePage = false) {
    setDetailEnabled(true)
    if (item.id !== lastCompany?.id) setStatement('all')
    if (!restorePage && item.id !== lastCompany?.id) setFilingPage(1)
    setRecent(previous => [item, ...previous.filter(entry => entry.id !== item.id)].slice(0, 5))
    setLastCompany(item)
    setShowDetail(true)
    requestAnimationFrame(() => companyHeading.current?.focus())
  }

  return <div className="company-grid" data-detail={showDetail} data-selected={!!selected}>
    <section className="panel disclosures-panel company-search">
    <div className="section-heading"><h2>국내 기업 검색</h2>
      </div>
    <form className="disclosure-controls quote-search-controls" onSubmit={event => {
      event.preventDefault()
      const query = term.trim()
      if (composing.current || !query || (query === search && searchPath && searchResult === undefined)) return
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
      <label>기업명·종목코드 <input {...inputEvents} ref={input} value={term} onChange={event => setTerm(event.target.value)} maxLength={64} required
        placeholder="기업명 또는 종목코드" /></label>
      <SearchButton pending={!!searchPath && searchResult === undefined} disabled={!term.trim() || term.trim() === search && !!searchPath && searchResult === undefined} />
    </form>
    {recent.length > 0 && <div className="recent-companies" aria-label="최근 조회 기업">
      <small>최근 조회</small>
      {recent.map(item => <button type="button" className="button" key={item.id} onClick={() => openCompany(item)}>{item.name}</button>)}
    </div>}
    {search && searchEnabled && <div>
      <div id={resultsId} aria-live="polite" aria-busy={!!searchPath && searchResult === undefined}>
        {searchResult === undefined ? <LoadingSkeleton message="기업을 검색하는 중입니다." shape="rows" />
          : !visibleCompanies?.length ? <p className="state">{searchResult.data === null
            ? searchResult.errorCode === 'PROVIDER_TIMEOUT' ? '응답 시간 초과' : '조회 불가' : '검색 결과 없음'}</p>
          : <ul className="disclosure-list company-results">
            {visibleCompanies.map(item => <li key={`${item.id}/${item.ticker}`}><button type="button" className="company-result" aria-current={item.id === selected?.id || undefined} onClick={() => openCompany(item)}>
              <span>{item.name}</span><span className="company-code">{item.ticker ?? '종목코드 없음'}</span>
            </button></li>)}
          </ul>}
      </div>
      <Pager label="기업 검색 페이지" page={searchPage} totalPages={searchPages} controls={resultsId} onChange={setSearchPage} />
    </div>}
    </section>
    {selected && <section className="panel disclosures-panel company-detail" aria-label="기업 상세정보">
      <button className="button company-back" onClick={() => {
        setShowDetail(false)
        requestAnimationFrame(() => input.current?.focus())
      }}>검색 결과로 돌아가기</button>
      <div className="section-heading"><h2 ref={companyHeading} tabIndex={-1}>{selected.name} · {selected.ticker ?? selected.id}</h2></div>
      <div className="disclosure-controls">
        <label>사업연도 <select value={year} onChange={event => { setYear(event.target.value); setDetailEnabled(true) }}>
          {Array.from({ length: new Date().getFullYear() - 2014 }, (_, i) => new Date().getFullYear() - i)
            .map(value => <option key={value}>{value}</option>)}
        </select></label>
        <label>보고기간 <select value={period} onChange={event => { setPeriod(event.target.value); setDetailEnabled(true) }}>
          {reportPeriods.map(value => <option key={value} value={value}>{periods[value]}</option>)}
        </select></label>
      </div>
      {!detailEnabled ? <button type="button" className="button" onClick={() => openCompany(selected, true)}>공시·재무 조회</button> : !detail ? <div className="state"><p role="status">{detail === undefined ? '조회 중' : '조회 불가'}</p>
        {detail === null && <button className="button" onClick={() => {
          setDetailAttempt(value => value + 1)
        }}>다시 시도</button>}</div> : <>
        <h3>최근 공시</h3>
        <ul id={filingsId} className="disclosure-list">{visibleFilings.map(item => <li key={item.id}>
          <a href={item.url}>{item.title}</a> · 공시일 {item.filedAt}{item.reportEnd && ` · 결산일 ${item.reportEnd}`}{item.amended && ' · 정정'}
        </li>)}</ul>
        <Pager label="최근 공시 페이지" page={shownFilingPage} totalPages={filingPages} controls={filingsId} onChange={setFilingPage} />
        {!detail.filings.length && <p className="state">{detail.filingsError ? '최근 공시 조회 불가' : '조회 기간에 공시 없음'}</p>}
        <h3>주요 재무정보</h3>
        {!!detail.financials.length && <label className="amount-display">
          재무제표 <select value={statement} onChange={event => setStatement(event.target.value)}>
            <option value="all">전체</option>
            {Object.entries(statements).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>}
        {!!financials.length && <div className="disclosure-table" tabIndex={0} role="region" aria-label="재무정보 표"><table>
          <thead><tr><th scope="col">항목</th><th scope="col">구분</th><th scope="col">보고기간</th><th scope="col">금액</th></tr></thead>
          <tbody>{financials.map(row => {
            const report = detail.filings.find(item => item.id === row.filingId)
            const reportUrl = report?.url ?? (/^\d{14}$/.test(row.filingId)
              ? `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${row.filingId}` : undefined)
            const label = `${row.year ?? `${row.start} ~ ${row.end}`} · ${periods[row.period]}${row.basis === 'year-to-date' ? ' 누적' : row.basis === 'current-period' ? ' 당기' : ''}`
            return <tr key={`${row.filingId}/${row.statement}/${row.metric}`}>
              <td>{metricNames[row.metric]}</td><td>{statements[row.statement]}</td>
              <td>{reportUrl ? <a href={reportUrl}>{label}</a> : label}{row.end && ` · 기간 종료일 ${row.end}`}{report?.amended && ' · 정정'}</td>
              <td className="financial-amount">{row.unit === 'KRW' ? formatWon(row.value) : number.format(typeof row.value === 'string' ? BigInt(row.value) : row.value) + ' ' + row.unit}</td>
            </tr>
          })}</tbody>
        </table></div>}
        {!financials.length && <p className="state">{detail.financialsError ? '재무정보 조회 불가' : '선택한 보고기간의 재무자료 없음'}</p>}
        {(detail.filingsError || detail.financialsError) && <button type="button" className="button"
          onClick={() => setDetailAttempt(value => value + 1)}>공시·재무 다시 시도</button>}
      </>}
    </section>}
  </div>
}
