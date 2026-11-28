import { createHash } from 'node:crypto'
import { calculateFundamentals } from './fundamental-ratios-provider.mjs'
import { isDay, ProviderError } from './public-provider.mjs'

const sha256 = value => createHash('sha256').update(JSON.stringify(value, (_, item) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)).digest('hex')

function storedReport(report, corpCode) {
  const { year, reportCode, scope, receipt, sourceVersion, collectedAt, fiscalEnd } = report
  const accounts = report.accounts.filter(account => !account.sameBalanceAs)
    .map(({ id, current, previous, currency, unit, ...metadata }) => ({
      account_key: id, current_amount: current?.status === 'reported' ? current.value : null,
      previous_amount: previous?.status === 'reported' ? previous.value : null,
      currency, unit,
      evidence: { ...metadata, current: { status: current?.status, reason: current?.reason },
        previous: { status: previous?.status, reason: previous?.reason } },
    })).sort((a, b) => a.account_key.localeCompare(b.account_key))
  const provenance = { source: report.source, receipt, scopeReason: report.scopeReason, earlierReceipts: report.earlierReceipts,
    incomePeriods: report.incomePeriods, accountingStandard: report.accountingStandard, rowCount: report.rowCount }
  const content = { corp_code: corpCode, business_year: Number(year), report_code: reportCode, scope,
    receipt_id: receipt.id, source_version: sourceVersion, fiscal_end: fiscalEnd, filed_at: receipt.filedAt, provenance, accounts }
  return { ...content, collected_at: collectedAt, source_hash: sha256(content) }
}

function storedMetrics(metrics) {
  return Object.fromEntries(metrics.map(({ id, calculatedAt, sources, value, ...metric }) => [id, {
    ...metric, value, searchValue: metric.status === 'success' ? value : null,
  }]))
}

export function createFinancialStorage({ readFinancials, readMarket, stage, clock = Date.now }) {
  let running
  async function sync(symbol) {
    const evaluationDate = new Date(clock() + 9 * 3_600_000).toISOString().slice(0, 10)
    const financials = await readFinancials(symbol, evaluationDate)
    if (financials.mode != null && financials.mode !== 'observed') {
      throw new ProviderError(409, 'FINANCIAL_STORAGE_SOURCE_UNVERIFIED')
    }
    const { mapping, years } = financials
    const { issuer, issue, issueAsOf } = mapping ?? {}
    if (mapping?.status !== 'exact-code' || issue?.symbol !== symbol || !/^\d{8}$/.test(issuer?.corpCode ?? '')
      || !isDay(issueAsOf) || issueAsOf > evaluationDate || !issue.isin || !issue.shareClass) {
      throw new ProviderError(409, 'FINANCIAL_STORAGE_IDENTITY_UNVERIFIED')
    }
    const reports = years.filter(report => report.status === 'available' && report.period === 'annual' &&
      report.issuerCorpCode === issuer.corpCode && /^\d{14}$/.test(report.receipt?.id ?? '')
      && isDay(report.receipt.filedAt) && report.receipt.filedAt <= evaluationDate
      && Number.isSafeInteger(report.sourceVersion) && Number.isFinite(Date.parse(report.collectedAt)))
      .map(report => storedReport(report, issuer.corpCode))
      .sort((a, b) => a.business_year - b.business_year || a.receipt_id.localeCompare(b.receipt_id))
    if (!reports.length) throw new ProviderError(409, 'FINANCIAL_STORAGE_NO_VERIFIED_FILINGS')
    const market = await readMarket(symbol)
    const result = calculateFundamentals({ evaluationDate, financials, market }, clock)
    const instrument = { market: issue.market, symbol, isin: issue.isin, share_class: issue.shareClass,
      as_of: issueAsOf, corp_code: issuer.corpCode }
    const snapshot = {
      corp_code: issuer.corpCode, issuer_name: issuer.name, market: issue.market, symbol, issue_as_of: issueAsOf,
      evaluation_date: evaluationDate, formula_version: result.version,
      coverage: 'partial-coverage', sector: mapping.sector,
      issuer_market_cap: result.market.issuer.status === 'success' ? result.market.issuer.value : null,
      metrics: storedMetrics(result.metrics),
    }
    const versions = reports.map(report => report.source_hash)
    const newestReport = reports.map(report => new Date(report.collected_at).toISOString()).sort().at(-1)
    const snapshotId = sha256({ instrument, snapshot, versions, market })
    const payload = { mode: result.mode, instrument, reports,
      snapshot: { ...snapshot, snapshot_id: snapshotId, source_observed_at: newestReport } }
    const saved = await stage(payload)
    if (saved?.snapshotId !== snapshotId || !['staged', 'unchanged'].includes(saved.status)) {
      throw new ProviderError(503, 'FINANCIAL_STORAGE_UNAVAILABLE')
    }
    return saved
  }

  return symbol => {
    if (running?.symbol === symbol) return running.promise
    if (running) throw new ProviderError(503, 'FINANCIAL_STORAGE_BUSY')
    const promise = sync(symbol).finally(() => { running = undefined })
    running = { symbol, promise }
    return promise
  }
}
