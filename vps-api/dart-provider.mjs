import { fileURLToPath } from 'node:url'
import { createDartFinancialCollector } from './dart-financials-provider.mjs'
import { unzipSync } from 'fflate'
import { XMLParser } from 'fast-xml-parser'
import { createMarketCache, MarketError } from './market-cache.mjs'
import { invalidResponse, isDay, providerClient, ProviderError, withHealthMetadata } from './public-provider.mjs'

const source = { name: '금융감독원 OPEN DART', url: 'https://opendart.fss.or.kr/' }
export const dartPeriods = { annual: '11011', q1: '11013', half: '11012', q3: '11014' }
const metrics = {
  '매출액': 'revenue', '영업수익': 'revenue', '영업이익': 'operatingIncome',
  '영업이익(손실)': 'operatingIncome', '당기순이익': 'netIncome', '당기순이익(손실)': 'netIncome',
}
const parser = new XMLParser({ parseTagValue: false, isArray: name => name === 'list' })

function companiesFrom(archive) {
  try {
    const file = unzipSync(archive, { filter: entry => entry.name === 'CORPCODE.xml' && entry.originalSize <= 40 * 1024 * 1024 })
    if (!file['CORPCODE.xml']) throw invalidResponse()
    const xml = new TextDecoder('utf-8', { fatal: true }).decode(file['CORPCODE.xml'])
    if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw invalidResponse()
    const rows = parser.parse(xml)?.result?.list
    if (!Array.isArray(rows) || !rows.length) throw invalidResponse()
    return rows.flatMap(row => {
      if (typeof row?.stock_code !== 'string') throw invalidResponse()
      if (!row.stock_code.trim()) return []
      if (!/^[0-9A-Z]{6}$/.test(row.stock_code) || typeof row.corp_code !== 'string'
        || !/^\d{8}$/.test(row.corp_code) || typeof row.corp_name !== 'string' || !row.corp_name.trim()) throw invalidResponse()
      return [{ id: row.corp_code, ticker: row.stock_code, name: row.corp_name }]
    })
  } catch {
    throw invalidResponse()
  }
}

function checkedRows(response) {
  if (response?.status === '013') return []
  if (['020', '800'].includes(response?.status)) throw new ProviderError(503, 'DART_PROVIDER_LIMITED')
  if (typeof response?.status !== 'string') throw invalidResponse()
  if (response.status !== '000') throw new ProviderError(502, 'DART_PROVIDER_ERROR')
  if (!Array.isArray(response.list)) throw invalidResponse()
  return response.list
}

const filingUrl = id => `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${id}`
function displayDate(date) {
  return typeof date === 'string' && /^\d{8}$/.test(date) ? date.replace(/^(....)(..)(..)$/, '$1-$2-$3') : ''
}

function filingsFrom(rows, corpCode) {
  const filings = new Map()
  for (const row of rows) {
    const filedAt = displayDate(row?.rcept_dt)
    if (row?.corp_code !== corpCode || typeof row.rcept_no !== 'string' || !/^\d{14}$/.test(row.rcept_no)
      || !isDay(filedAt) || typeof row.report_nm !== 'string') throw invalidResponse()
    const id = row.rcept_no
    filings.set(id, { id, title: row.report_nm, filedAt, amended: /정정/.test(row.report_nm), url: filingUrl(id) })
  }
  return [...filings.values()].sort((a, b) => b.filedAt.localeCompare(a.filedAt) || b.id.localeCompare(a.id)).slice(0, 20)
}

function financialsFrom(rows, year, period, company) {
  const selected = new Map()
  const conflicts = new Set()
  for (const row of rows) {
    if (row?.corp_code !== company.id || typeof row.stock_code !== 'string' || !/^[0-9A-Z]{6}$/.test(row.stock_code)
      || row.bsns_year !== year || row.reprt_code !== dartPeriods[period]) throw invalidResponse()
    if (row.sj_div !== 'IS' || !Object.hasOwn(metrics, row.account_nm)) continue
    const statement = { CFS: 'consolidated', OFS: 'separate' }[row.fs_div]
    if (!statement || !/^\d{14}$/.test(row.rcept_no ?? '')) throw invalidResponse()
    const raw = period === 'annual' ? row.thstrm_amount : (row.thstrm_add_amount || (period === 'q1' ? row.thstrm_amount : null))
    if (typeof raw !== 'string' || !/^-?(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(raw)) continue
    if (typeof row.currency !== 'string' || !/^[A-Z]{3}$/.test(row.currency)) throw invalidResponse()
    const metric = metrics[row.account_nm]
    const date = typeof row.thstrm_dt === 'string'
      ? row.thstrm_dt.match(/\d{4}\.\d{2}\.\d{2}/g)?.at(-1)?.replaceAll('.', '-')
      : undefined
    const id = `${statement}/${metric}`
    const item = { metric, unit: row.currency, value: raw.replaceAll(',', ''), statement, year, period,
      basis: period === 'annual' ? 'annual' : 'year-to-date',
      ...(isDay(date) && { end: date }),
      filingId: row.rcept_no, url: filingUrl(row.rcept_no) }
    const existing = selected.get(id)
    if (!existing || existing.filingId < item.filingId) {
      selected.set(id, item)
      conflicts.delete(id)
    } else if (existing.filingId === item.filingId && (existing.value !== item.value || existing.unit !== item.unit)) {
      conflicts.add(id)
    }
  }
  return [...selected].filter(([id]) => !conflicts.has(id)).map(([, row]) => row)
}

export function createDartProvider({
  key = process.env.DART_API_KEY, fetchImpl = fetch, clock = Date.now, issueFor,
  financialRoot = process.env.DART_FINANCIAL_CACHE_DIR || fileURLToPath(new URL('.dart-cache/', import.meta.url)),
} = {}) {
  // Catalog and JSON requests share one limiter. Only the parsed catalog is cached in memory.
  const get = providerClient(fetchImpl, 1000, { queue: true, binary: true, maxBytes: 8 * 1024 * 1024, dailyLimit: 2000, timeoutMs: 3500 })
  const filingsCache = createMarketCache({ maxEntries: 32, maxBytes: 384 * 1024, maxPending: 4, timeoutMs: 6000, wallClock: clock })
  const request = (path, params, timeoutMs, observeResponse) => get(`https://opendart.fss.or.kr/api/${path}?${new URLSearchParams({
      crtfc_key: key.trim(), ...params,
  })}`, {}, timeoutMs, observeResponse)
  function json(body) {
    try { return JSON.parse(body.toString('utf8')) } catch { throw invalidResponse() }
  }
  let catalog
  let catalogExpires = -Infinity
  let pendingCatalog
  async function loadCatalog() {
    const archive = await request('corpCode.xml', {}, 7500)
    if (archive.length < 2 || archive.readUInt16LE(0) !== 0x4b50) {
      const body = archive.toString('utf8').trim()
      if (/^<\?xml|^<result>/.test(body) && !/<!DOCTYPE|<!ENTITY/i.test(body)) {
        checkedRows(parser.parse(body)?.result)
      } else {
        checkedRows(json(archive))
      }
      throw invalidResponse()
    }
    catalog = companiesFrom(archive)
    catalogExpires = clock() + 60 * 60_000
    return catalog
  }
  async function readRows(load) {
    try {
      return { rows: await load() }
    } catch (error) {
      if (error instanceof MarketError) return { rows: [], error: new ProviderError(error.statusCode, 'DART_FILINGS_UNAVAILABLE') }
      if (!(error instanceof ProviderError)) throw error
      return { rows: [], error }
    }
  }
  async function readCatalog() {
    if (!key?.trim()) throw new ProviderError(503, 'DART_CONFIGURATION_MISSING')
    if (clock() >= catalogExpires) pendingCatalog ??= loadCatalog().finally(() => { pendingCatalog = undefined })
    return pendingCatalog ?? catalog
  }

  async function requestRows(path, params) {
    let httpStatus
    try {
      return checkedRows(json(await request(path, params, undefined, status => { httpStatus = status })))
    } catch (error) {
      if ([500, 502, 503, 504].includes(httpStatus) && error.code === 'PROVIDER_UNAVAILABLE')
        throw new ProviderError(503, 'DART_UPSTREAM_TRANSIENT')
      throw error
    }
  }

  const query = async ({ q, corpCode, year, period, page }) => {
    const catalogCached = clock() < catalogExpires
    const companies = await readCatalog()
    if (!corpCode) {
      const term = q.trim().toUpperCase()
      const matches = companies.filter(company => company.ticker === term || company.id === term
        || company.name.toUpperCase().includes(term))
        .sort((a, b) => Number(b.ticker === term || b.id === term) - Number(a.ticker === term || a.id === term))
      const offset = page === undefined ? 0 : (page - 1) * 10
      return withHealthMetadata({ source, total: matches.length, companies: matches.slice(offset, offset + (page === undefined ? 20 : 10)) },
        { usedCache: catalogCached, attempted: !catalogCached })
    }
    const company = companies.find(item => item.id === corpCode)
    if (!company) throw new ProviderError(404, 'COMPANY_NOT_FOUND')
    const compact = time => new Date(time).toISOString().slice(0, 10).replaceAll('-', '')
    const now = clock() + 9 * 60 * 60_000
    const end = compact(now)
    let filingsCached = false
    const filings = await readRows(async () => {
      const result = await filingsCache.get(`${corpCode}:${end}`, { ttlMs: 5 * 60_000, staleAfterMs: 0 }, async () => ({
        asOf: new Date(clock()).toISOString(),
        data: filingsFrom(checkedRows(json(await request('list.json', {
          corp_code: corpCode, bgn_de: compact(now - 90 * 86_400_000), end_de: end,
          last_reprt_at: 'N', sort: 'date', sort_mth: 'desc', page_count: '30',
        }))), corpCode),
      }))
      filingsCached = result.cacheHit
      return JSON.parse(result.body)
    })
    const financials = year ? await readRows(async () => financialsFrom(checkedRows(json(await request('fnlttSinglAcnt.json', {
      corp_code: corpCode, bsns_year: year, reprt_code: dartPeriods[period],
    }))), year, period, company)) : { rows: [] }
    if (filings.error && (!year || financials.error)) throw filings.error
    return withHealthMetadata({ source, company, filings: filings.rows, financials: financials.rows,
      ...(filings.error && { filingsError: filings.error.code }),
      ...(financials.error && { financialsError: financials.error.code }) },
    { usedCache: catalogCached || filingsCached, attempted: !catalogCached || !filingsCached || Boolean(year) })
  }
  if (issueFor) query.collectFinancials = createDartFinancialCollector({
    root: financialRoot, issueFor, catalog: readCatalog, requestRows, clock, source,
  })
  return query
}
