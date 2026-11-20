import { invalidResponse, isDay, providerClient, ProviderError } from './public-provider.mjs'

const source = { name: 'SEC EDGAR', url: 'https://www.sec.gov/search-filings' }
const dataHost = 'https://data.sec.gov'
const forms = ['10-K', '10-Q', '10-K/A', '10-Q/A']
const metrics = {
  revenue: ['RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues', 'SalesRevenueNet'],
  operatingIncome: ['OperatingIncomeLoss'],
  netIncome: ['NetIncomeLoss', 'ProfitLoss'],
}

// One request scheduler per Node process, shared by the ticker, submissions, and XBRL endpoints.
const requestOptions = { queue: true, forbiddenCooldownMs: 60 * 60_000 }
const liveClient = providerClient(fetch, 250, requestOptions)
const companyId = cik => String(cik).padStart(10, '0')

function filingsFrom(submissions, cik) {
  const recent = submissions?.filings?.recent
  const columns = ['form', 'filingDate', 'reportDate', 'accessionNumber', 'primaryDocument']
  if (companyId(submissions?.cik) !== cik || typeof submissions?.name !== 'string'
    || !columns.every(key => Array.isArray(recent?.[key]) && recent[key].length === recent.form.length)) throw invalidResponse()
  const seen = new Set()
  const filings = []
  for (const [i, form] of recent.form.entries()) {
    if (!forms.includes(form)) continue
    const id = recent.accessionNumber[i]
    const filedAt = recent.filingDate[i]
    const reportEnd = recent.reportDate[i]
    const document = recent.primaryDocument[i]
    if (typeof id !== 'string' || !/^\d{10}-\d{2}-\d{6}$/.test(id) || !isDay(filedAt) || !isDay(reportEnd)
      || reportEnd > filedAt || typeof document !== 'string' || !/^[\w.-]+\.(html?|txt)$/i.test(document)) throw invalidResponse()
    if (seen.has(id)) continue
    seen.add(id)
    filings.push({ id, title: form, filedAt, reportEnd, amended: form.endsWith('/A'),
      url: `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${id.replaceAll('-', '')}/${document}` })
  }
  return filings.sort((a, b) => b.filedAt.localeCompare(a.filedAt) || b.id.localeCompare(a.id))
}

function financialsFrom(document, cik, filings) {
  const gaap = document?.facts?.['us-gaap']
  if (companyId(document?.cik) !== cik || !document.facts || typeof document.facts !== 'object') throw invalidResponse()
  if (gaap == null) return []
  if (typeof gaap !== 'object' || Array.isArray(gaap)) throw invalidResponse()
  return filings.slice(0, 8).flatMap(filing => Object.entries(metrics).flatMap(([metric, concepts]) => {
    const annual = filing.title.startsWith('10-K')
    for (const concept of concepts) {
      const usd = gaap[concept]?.units?.USD
      if (usd === undefined) continue
      if (!Array.isArray(usd)) throw invalidResponse()
      const candidates = usd.filter(row => {
        if (row?.accn !== filing.id || row.form !== filing.title || row.end !== filing.reportEnd || row.filed !== filing.filedAt
          || !isDay(row.start) || !Number.isFinite(row.val)) return false
        const days = (Date.parse(row.end) - Date.parse(row.start)) / 86_400_000 + 1
        return annual ? days >= 350 && days <= 380 : days >= 70 && days <= 110
      })
      const distinct = new Map(candidates.map(row => [JSON.stringify([row.start, row.val]), row]))
      if (distinct.size !== 1) continue
      const row = distinct.values().next().value
      return [{ metric, concept, value: row.val, unit: 'USD', start: row.start, end: row.end,
        period: annual ? 'annual' : 'quarter', statement: 'entity-wide', filingId: filing.id }]
    }
    return []
  }))
}

export function createSecProvider({ userAgent = process.env.SEC_USER_AGENT, fetchImpl, clock } = {}) {
  const get = fetchImpl ? providerClient(fetchImpl, 250, { ...requestOptions, clock }) : liveClient
  return async ({ q, cik: requested }) => {
    if (!userAgent || !/^[\x20-\x7e]{5,200}$/.test(userAgent) || !/^.+\s[^\s@]+@[^\s@]+\.[^\s@]+$/.test(userAgent)) {
      throw new ProviderError(503, 'SEC_CONFIGURATION_MISSING')
    }
    const request = url => get(url, { 'User-Agent': userAgent })
    if (!requested) {
      const catalog = await request('https://www.sec.gov/files/company_tickers.json')
      if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) throw invalidResponse()
      const term = q.trim().toUpperCase()
      const records = Object.values(catalog).map(row => {
        if (!Number.isInteger(row?.cik_str) || row.cik_str < 1 || row.cik_str > 9_999_999_999
          || typeof row.ticker !== 'string' || typeof row.title !== 'string') throw invalidResponse()
        return { id: companyId(row.cik_str), ticker: row.ticker, name: row.title }
      })
      return { source, companies: records.filter(row => row.id === companyId(term)
        || row.ticker.toUpperCase().includes(term) || row.name.toUpperCase().includes(term))
        .sort((a, b) => Number(b.ticker === term) - Number(a.ticker === term)).slice(0, 20) }
    }
    const cik = companyId(requested)
    const submissions = await request(`${dataHost}/submissions/CIK${cik}.json`)
    const filings = filingsFrom(submissions, cik)
    const financials = filings.length
      ? financialsFrom(await request(`${dataHost}/api/xbrl/companyfacts/CIK${cik}.json`), cik, filings)
      : []
    return { source, company: { id: cik, name: submissions.name }, filings: filings.slice(0, 20), financials }
  }
}
