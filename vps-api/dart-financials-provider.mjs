import { randomUUID } from 'node:crypto'
import { mkdir, open, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { dartFiscalDates, normalizeDartAccounts } from './dart-accounts-provider.mjs'
import { isDay, ProviderError } from './public-provider.mjs'

const sample = new Map([
  ['005930', 'non-financial'],
  ['373220', 'non-financial'], ['263860', 'non-financial'], ['150900', 'non-financial'], ['001450', 'financial-insurance'],
])
const preferredSamples = new Set(['005935'])
const version = 1
const maxFileBytes = 128 * 1024
const dayMs = 86_400_000
const reportCode = '11011'
const period = 'annual'

export function dartIssueMapping(issue, companies, observedAt) {
  const matches = issue ? companies.filter(company => company.ticker === issue.symbol) : []
  const ids = new Set(matches.map(company => company.id))
  const company = ids.size === 1 && matches.every(candidate => candidate.name === matches[0].name) ? matches[0] : null
  return {
    issue, issuer: company ? { corpCode: company.id, name: company.name } : null,
    source: company ? 'KRX + OpenDART corpCode.xml (exact stock code)' : null,
    issueAsOf: issue?.asOf ?? null, verifiedAt: company ? observedAt : null, status: company ? 'exact-code' : 'unverified',
    reason: company ? null : !issue ? 'krx-issue-unavailable' : matches.length ? 'ambiguous-corp-code' : 'no-exact-code',
    sector: issue ? sample.get(issue.symbol) ?? null : null,
  }
}

function dayFromReceipt(receipt) {
  const date = receipt.slice(0, 8).replace(/^(....)(..)(..)$/, '$1-$2-$3')
  return isDay(date) ? date : null
}

async function readSnapshot(path, corpCode, year) {
  let file
  try {
    file = await open(path, 'r')
    const bytes = Buffer.alloc(maxFileBytes + 1)
    let length = 0
    for (;;) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, null)
      length += bytesRead
      if (length > maxFileBytes) return null
      if (!bytesRead) break
    }
    const saved = JSON.parse(bytes.toString('utf8', 0, length))
    return saved?.version === version && (corpCode === null || saved.corpCode === corpCode) && (Array.isArray(year) ? year.includes(saved.year) : saved.year === year) &&
      Number.isFinite(saved.savedAt) && ['available', 'not-provided'].includes(saved.statement?.status) &&
      saved.statement.year === saved.year && Array.isArray(saved.statement.accounts) ? saved : null
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return null
    throw new ProviderError(503, 'DART_FINANCIAL_CACHE_UNAVAILABLE')
  } finally {
    await file?.close()
  }
}

async function saveSnapshot(path, snapshot) {
  const bytes = JSON.stringify(snapshot)
  if (Buffer.byteLength(bytes) > maxFileBytes) throw new ProviderError(502, 'DART_FINANCIAL_SNAPSHOT_TOO_LARGE')
  const temporary = path + '.' + randomUUID() + '.tmp'
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600, flush: true })
    await rename(temporary, path)
  } catch {
    throw new ProviderError(503, 'DART_FINANCIAL_CACHE_UNAVAILABLE')
  } finally {
    await unlink(temporary).catch(() => {})
  }
}

export function createDartFinancialCollector({ root, issueFor, catalog, requestRows, clock, source }) {
  let running
  const requests = []
  async function request(path, params) {
    for (let attempt = 0; ; attempt++) {
      const now = clock()
      while (requests.length && now - requests[0] >= dayMs) requests.shift()
      if (requests.length >= 100) throw new ProviderError(503, 'DART_FINANCIAL_BUDGET_EXHAUSTED')
      requests.push(now)
      try {
        return await requestRows(path, params)
      } catch (error) {
        if (attempt || !['PROVIDER_TIMEOUT', 'DART_UPSTREAM_TRANSIENT'].includes(error.code)) throw error
        // The provider's shared limiter supplies the minimum interval before retry.
      }
    }
  }

  async function collectYear(corpCode, stockCode, year) {
    const params = { corp_code: corpCode, bsns_year: year, reprt_code: reportCode }
    let scope = 'CFS'
    let rows = await request('fnlttSinglAcntAll.json', { ...params, fs_div: scope })
    if (!rows.length) {
      scope = 'OFS'
      rows = await request('fnlttSinglAcntAll.json', { ...params, fs_div: scope })
    }
    const report = { year, period, reportCode, accountingStandard: null, source }
    if (!rows.length) return { ...report, collectedAt: new Date(clock()).toISOString(), status: 'not-provided', scope: null, scopeReason: 'both-unavailable',
      receipt: null, fiscalEnd: null, accounts: [], reason: 'no-report' }

    const normalized = normalizeDartAccounts(rows, { corpCode, year, period, reportCode, scope })
    const hint = dayFromReceipt(normalized.receipt)
    const compact = hint?.replaceAll('-', '')
    const filings = hint ? await request('list.json', { corp_code: corpCode, bgn_de: compact, end_de: compact,
      pblntf_ty: 'A', last_reprt_at: 'N', page_count: '100' }) : []
    const filing = filings.find(row => row?.rcept_no === normalized.receipt && row.corp_code === corpCode &&
      typeof row.rcept_dt === 'string' && /^\d{8}$/.test(row.rcept_dt) && dayFromReceipt(row.rcept_dt) === hint)
    const particulars = await request('fnlttSinglAcnt.json', params)
    const { fiscalEnd, incomePeriod } = dartFiscalDates(particulars, { receipt: normalized.receipt, stockCode, year, reportCode, scope })
    const name = typeof filing?.report_nm === 'string' ? filing.report_nm : null
    return { ...report, collectedAt: new Date(clock()).toISOString(), status: 'available', scope, scopeReason: scope === 'CFS' ? 'consolidated' : 'consolidated-unavailable',
      fiscalEnd, incomePeriod, receipt: { id: normalized.receipt, filedAt: filing ? dayFromReceipt(filing.rcept_dt) : null,
        amendment: name === null ? 'unverified' : /정정/.test(name) ? 'amended' : 'as-filed',
        title: name, url: 'https://dart.fss.or.kr/dsaf001/main.do?rcpNo=' + normalized.receipt },
      accounts: normalized.accounts, rowCount: normalized.rowCount, earlierReceipts: normalized.earlierReceipts,
      reason: !filing || !fiscalEnd ? 'report-metadata-incomplete' : null }
  }

  async function collect(symbol, years) {
    const issue = await issueFor(symbol)
    const mapping = dartIssueMapping(issue, issue ? await catalog() : [], new Date(clock()).toISOString())
    if (!mapping.issuer || !sample.has(symbol)) return { mapping, years: [], progress: { status: 'identity-only' } }
    const { corpCode } = mapping.issuer
    try {
      await mkdir(root, { recursive: true, mode: 0o700 })
    } catch {
      throw new ProviderError(503, 'DART_FINANCIAL_CACHE_UNAVAILABLE')
    }
    const results = []
    for (const year of years) {
      const path = join(root, symbol + '-' + (Number(year) % 3) + '.json')
      const saved = await readSnapshot(path, corpCode, year)
      if (saved && clock() >= saved.savedAt && clock() - saved.savedAt < dayMs &&
          (!saved.mapping || (saved.mapping.issue?.isin === issue.isin && saved.mapping.issue?.market === issue.market &&
          saved.mapping.issue?.shareClass === issue.shareClass))) {
        results.push({ ...saved.statement, cache: 'hit' })
        continue
      }
      try {
        const statement = await collectYear(corpCode, symbol, year)
        await saveSnapshot(path, { version, corpCode, year, savedAt: clock(), mapping, statement })
        results.push({ ...statement, cache: 'updated' })
      } catch (error) {
        if (!(error instanceof ProviderError) || !results.length) throw error
        return { mapping, years: results, progress: { status: 'partial', failedYear: year, reason: error.code } }
      }
    }
    return { mapping, years: results, progress: { status: 'complete' } }
  }

  const run = async symbol => {
    if (!sample.has(symbol) && !preferredSamples.has(symbol)) throw new ProviderError(404, 'DART_FINANCIAL_SAMPLE_NOT_FOUND')
    if (running?.symbol === symbol) return running.promise
    if (running) throw new ProviderError(503, 'DART_FINANCIAL_COLLECTION_BUSY')
    const year = Number(new Date(clock() + 9 * 3600_000).toISOString().slice(0, 4))
    const years = [year - 1, year - 2, year - 3].filter(value => value >= 2015).map(String)
    const promise = collect(symbol, years).finally(() => { running = undefined })
    running = { symbol, promise }
    return promise
  }

  run.readCached = async (symbol, evaluationDate) => {
    if (!sample.has(symbol) && !preferredSamples.has(symbol)) throw new ProviderError(404, 'DART_FINANCIAL_SAMPLE_NOT_FOUND')
    const currentIssue = await issueFor(symbol)
    if (!currentIssue || !isDay(currentIssue.asOf) || currentIssue.asOf > evaluationDate) return { mapping: null, years: [] }
    const snapshots = []
    for (let slot = 0; slot < 3; slot++) {
      const path = join(root, symbol + '-' + slot + '.json')
      const fileYear = Number(evaluationDate.slice(0, 4))
      const expected = [fileYear, fileYear - 1, fileYear - 2, fileYear - 3]
      // The rolling cache has three slots. Validate the envelope before using any contents.
      const saved = await readSnapshot(path, null, expected.filter(year => year % 3 === slot).map(String))
      if (saved) snapshots.push(saved)
    }
    const sameIssue = saved => saved.mapping?.status === 'exact-code' && saved.corpCode === saved.mapping.issuer?.corpCode &&
      saved.mapping.issue?.symbol === symbol && saved.mapping.issue?.market === currentIssue.market &&
      saved.mapping.issue?.isin && saved.mapping.issue.isin === currentIssue.isin &&
      saved.mapping.issue.shareClass === currentIssue.shareClass &&
      isDay(saved.mapping.issueAsOf) && saved.mapping.issueAsOf <= evaluationDate && saved.savedAt <= clock()
    const verified = snapshots.filter(sameIssue).sort((a, b) => b.savedAt - a.savedAt)
    const candidate = verified[0]
    if (!candidate) return { mapping: { ...dartIssueMapping(currentIssue, [], null),
      reason: snapshots.length ? 'snapshot-identity-unverified' : 'financial-snapshot-unavailable' }, years: [] }
    if (verified.some(saved => saved.corpCode !== candidate.corpCode)) return {
      mapping: { ...dartIssueMapping(currentIssue, [], null), reason: 'conflicting-snapshot-issuers' }, years: [],
    }
    return { mapping: candidate.mapping, years: verified.map(saved => ({ ...saved.statement, issuerCorpCode: saved.corpCode,
      snapshotStale: clock() - saved.savedAt >= dayMs })) }
  }
  return run

}
