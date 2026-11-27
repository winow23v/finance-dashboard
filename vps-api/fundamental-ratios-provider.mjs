import { isDay } from './public-provider.mjs'

export const fundamentalFormulaVersion = '1'
const maxFractionDigits = 24
const annualCode = '11011'
const issuerCode = /^\d{8}$/
const receiptCode = /^\d{14}$/
const symbolCode = /^[0-9A-Z]{6}$/
const isinCode = /^KR[A-Z0-9]{10}$/
const accountReasons = {
  missing: ['missing-data', 'account-not-provided'],
  invalid: ['not-calculable', 'account-normalization-failed'],
}
const invalid = (status, reason, evidence = []) => ({ status, reason, evidence })
const missing = reason => invalid('missing-data', reason)
const success = (value, evidence = [], exact = null) => ({ status: 'success', reason: null, value, exact, evidence })

function decimal(value) {
  if (typeof value !== 'string' || !/^-?\d{1,80}(?:\.\d{1,40})?$/.test(value)) return null
  const [integer, fraction = ''] = value.split('.')
  return { coefficient: BigInt(integer + fraction), scale: fraction.length }
}

const pow10 = scale => 10n ** BigInt(scale)
function align(left, right) {
  const scale = Math.max(left.scale, right.scale)
  return [left.coefficient * pow10(scale - left.scale), right.coefficient * pow10(scale - right.scale), scale]
}

function add(left, right) {
  const [a, b, scale] = align(left, right)
  return { coefficient: a + b, scale }
}

const negate = value => ({ ...value, coefficient: -value.coefficient })
const positive = value => value.coefficient > 0n

function text({ coefficient, scale }) {
  if (!scale) return String(coefficient)
  const sign = coefficient < 0n ? '-' : ''
  const digits = String(coefficient < 0n ? -coefficient : coefficient).padStart(scale + 1, '0')
  return (sign + digits.slice(0, -scale) + '.' + digits.slice(-scale)).replace(/\.?0+$/, '')
}

function divide(numerator, denominator, multiplier) {
  const [left, right] = align(numerator, denominator)
  const signed = left * BigInt(multiplier)
  const unsigned = signed < 0n ? -signed : signed
  const scaled = unsigned * pow10(maxFractionDigits)
  // Round the decimal projection half away from zero. The exact fraction remains available.
  const rounded = (2n * scaled + right) / (2n * right)
  return { value: text({ coefficient: signed < 0n ? -rounded : rounded, scale: maxFractionDigits }),
    exact: { numerator: String(signed), denominator: String(right) } }
}

function money(value) {
  const amount = decimal(typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value)
  return amount && amount.coefficient >= 0n ? amount : null
}

function issueKey(issue) {
  if (!symbolCode.test(issue?.symbol ?? '') || !['KOSPI', 'KOSDAQ'].includes(issue.market) ||
      !isinCode.test(issue.isin ?? '') || typeof issue.shareClass !== 'string' || !issue.shareClass.trim()) return null
  return [issue.market, issue.symbol, issue.isin, issue.shareClass].join('/')
}

function valuation(row, evaluationDate) {
  if (!row || !isDay(row.tradingDate)) return missing('market-observation-unavailable')
  const evidence = { symbol: row.symbol, market: row.market, isin: row.isin, shareClass: row.shareClass,
    source: row.source ?? null, tradingDate: row.tradingDate, marketCap: row.marketCap ?? null,
    close: row.close ?? null, listedShares: row.listedShares ?? null }
  if (row.tradingDate !== evaluationDate)
    return invalid(row.tradingDate < evaluationDate ? 'stale' : 'unverified', 'market-date-mismatch', [evidence])
  if (row.source !== 'KRX OPEN API') return invalid('unverified', 'market-source-unverified', [evidence])
  if (row.marketCap != null) {
    const official = money(row.marketCap)
    return official && positive(official) ? success(text(official), [{ ...evidence, method: 'official-krx' }])
      : invalid('not-calculable', 'invalid-official-market-cap', [evidence])
  }
  const close = money(row.close)
  const shares = money(row.listedShares)
  if (!close || !shares || !positive(close) || !positive(shares) || shares.scale !== 0 ||
      row.listedSharesVerified !== true) return invalid('unverified', 'verified-market-cap-inputs-unavailable', [evidence])
  return success(text({ coefficient: close.coefficient * shares.coefficient, scale: close.scale }),
    [{ ...evidence, method: 'verified-close-times-listed-shares' }])
}

function aggregateMarket(market, mapping, date) {
  const key = isDay(mapping?.issueAsOf) && mapping.issueAsOf <= date ? issueKey(mapping.issue) : null
  const rows = Array.isArray(market?.issues) ? market.issues : []
  const primaryRows = key ? rows.filter(row => issueKey(row) === key) : []
  const primary = primaryRows.length && primaryRows.every(row => observationSignature(row) === observationSignature(primaryRows[0]))
    ? valuation(primaryRows[0], date) : primaryRows.length ? invalid('unverified', 'conflicting-market-observations')
      : missing('market-observation-unavailable')
  const currency = /^[A-Z]{3}$/.test(market?.currency ?? '') ? market.currency : null
  const coverage = market?.coverage
  const corpCode = mapping?.issuer?.corpCode
  const base = { currency, coverage: coverage?.status ?? 'unverified', candidates: [] }
  const result = (status, reason, details = {}) => ({ ...base, ...invalid(status, reason), ...details })
  if (!key || !issuerCode.test(corpCode ?? '') || mapping?.status !== 'exact-code')
    return { issue: primary, issuer: result('unverified', 'issuer-mapping-unverified') }
  if (!currency) return { issue: primary, issuer: result('unverified', 'market-currency-unverified') }
  if (coverage?.status !== 'verified' || coverage.corpCode !== corpCode || coverage.asOf !== date ||
      !Array.isArray(coverage.issues) || !coverage.issues.length)
    return { issue: primary, issuer: result('partial-coverage', 'issuer-issue-set-unverified') }
  const expected = new Map()
  const seenIsins = new Set()
  const seenSymbols = new Set()
  for (const issue of coverage.issues) {
    const identity = issueKey(issue)
    if (identity && expected.has(identity)) continue
    if (!identity || seenIsins.has(issue.isin) || seenSymbols.has(issue.symbol))
      return { issue: primary, issuer: result('unverified', 'conflicting-issuer-identities') }
    expected.set(identity, issue)
    seenIsins.add(issue.isin)
    seenSymbols.add(issue.symbol)
  }
  if (!expected.has(key) || rows.some(row => row?.corpCode === corpCode && !expected.has(issueKey(row))))
    return { issue: primary, issuer: result('partial-coverage', 'issuer-issue-set-inconsistent') }

  const candidates = []
  let total = decimal('0')
  for (const [identity, issue] of expected) {
    const matches = rows.filter(row => issueKey(row) === identity)
    const verified = matches.length && matches.every(row => row.corpCode === corpCode &&
      ['verified', 'exact-code'].includes(row.mappingStatus) && observationSignature(row) === observationSignature(matches[0]))
    const calculated = verified ? valuation(matches[0], date) : invalid(matches.length ? 'unverified' : 'missing-data',
      matches.length ? 'issue-mapping-or-observation-unverified' : 'required-issue-missing')
    candidates.push({ symbol: issue.symbol, isin: issue.isin, status: calculated.status,
      reason: calculated.reason, evidence: calculated.evidence })
    if (calculated.status === 'success') {
      const amount = decimal(calculated.value)
      if (!amount) return { issue: primary, issuer: result('not-calculable', 'issuer-cap-precision-limit', { candidates }) }
      total = add(total, amount)
    }
  }
  if (candidates.some(candidate => candidate.status !== 'success')) {
    const stale = candidates.every(candidate => ['success', 'stale'].includes(candidate.status))
    return { issue: primary, issuer: result(stale ? 'stale' : 'partial-coverage',
      stale ? 'market-date-mismatch' : 'issuer-market-cap-incomplete', { candidates }) }
  }
  return { issue: primary, issuer: { ...base, candidates,
    ...success(text(total), candidates.flatMap(candidate => candidate.evidence)) } }
}

function observationSignature(row) {
  return JSON.stringify([row.corpCode, row.mappingStatus, row.tradingDate, row.marketCap, row.close,
    row.listedShares, row.listedSharesVerified, row.source])
}

function account(report, id, term = 'current') {
  const rows = report.accounts.filter(row => row?.id === id)
  if (rows.length > 1) return invalid('not-calculable', 'duplicate-account')
  const row = rows[0]
  if (!row) return missing('account-not-provided')
  const amount = row[term]
  const evidence = [{ id, term, amount: amount?.value ?? null, currency: row.currency ?? null, unit: row.unit ?? null,
    accountId: row.original?.accountId ?? null, accountName: row.original?.name ?? null,
    sourceQuality: row.quality ?? null, sourceReason: amount?.reason ?? row.reason ?? null }]
  const [status, reason] = accountReasons[amount?.status] ?? accountReasons[row.quality] ?? accountReasons.invalid
  if (amount?.status !== 'reported' || row.quality !== 'reported')
    return invalid(status, reason, evidence)
  const parsed = decimal(amount.value)
  if (!parsed || row.unit !== 'currency-unit' || !/^[A-Z]{3}$/.test(row.currency ?? ''))
    return invalid('unverified', 'amount-currency-or-unit-unverified', evidence)
  const balance = ['assets', 'liabilities', 'equity', 'parentEquity', 'closingParentEquity'].includes(id)
  const allowedStatements = id.startsWith('opening') ? ['SCE'] : balance ? ['BS']
    : ['operatingCashFlow', 'propertyPlantEquipmentAcquisitions', 'intangibleAcquisitions'].includes(id) ? ['CF'] : ['IS', 'CIS']
  if ((row.scope != null && row.scope !== report.scope) || !allowedStatements.includes(row.statement))
    return invalid('not-calculable', 'account-scope-or-statement-mismatch', evidence)
  const allowedBasis = id.startsWith('opening') ? 'opening-balance'
    : balance ? 'point-in-time' : 'annual'
  if (row.basis !== allowedBasis) return invalid('not-calculable', 'account-period-incompatible', evidence)
  return { ...success(amount.value, evidence), currency: row.currency, amount: parsed, row }
}

function verifyOperands(operands) {
  const evidence = operands.flatMap(operand => operand.evidence)
  const failure = operands.find(operand => operand.status !== 'success')
  if (failure) return invalid(failure.status, failure.reason, evidence)
  if (new Set(operands.map(operand => operand.currency)).size > 1)
    return invalid('not-calculable', 'currency-mismatch', evidence)
  return { evidence }
}

function ratio(operands, expression, multiplier, reason) {
  const check = verifyOperands(operands)
  if (check.status) return check
  const [numerator, denominator] = expression(...operands.map(operand => operand.amount))
  if (!positive(denominator)) return invalid('not-calculable', reason, check.evidence)
  const { value, exact } = divide(numerator, denominator, multiplier)
  return success(value, check.evidence, exact)
}

function acquisitions(a, b) {
  if (a.row === b.row) return true
  const origin = row => [row.original?.accountId, row.original?.name, row.original?.detail]
  const [leftId, leftName, leftDetail] = origin(a.row)
  const [rightId, rightName, rightDetail] = origin(b.row)
  const generic = id => !id || id === '-표준계정코드 미사용-'
  return (!generic(leftId) && leftId === rightId) ||
    (leftName && leftName.replace(/\s+/g, '') === rightName?.replace(/\s+/g, '') && leftDetail === rightDetail)
}

function freeCashFlow(report) {
  const operands = ['operatingCashFlow', 'propertyPlantEquipmentAcquisitions', 'intangibleAcquisitions']
    .map(id => account(report, id))
  const check = verifyOperands(operands)
  if (check.status) return check
  if (acquisitions(operands[1], operands[2])) return invalid('not-calculable', 'duplicate-capex-source', check.evidence)
  const [operating, tangible, intangible] = operands.map(operand => operand.amount)
  const outflow = value => value.coefficient < 0n ? value : negate(value)
  const evidence = check.evidence.map((row, index) => index === 0 ? row : { ...row,
    normalizedOutflow: text(negate(outflow(operands[index].amount))), conversion: 'absolute-disclosed-acquisition' })
  const value = add(add(operating, outflow(tangible)), outflow(intangible))
  return { ...success(text(value), evidence), amount: value, currency: operands[0].currency }
}

function fullAnnualPeriod(period) {
  if (!isDay(period?.start) || !isDay(period?.end)) return false
  const days = (Date.parse(period.end) - Date.parse(period.start)) / 86_400_000 + 1
  return [365, 366].includes(days)
}

function annualIncomePeriod(report, operand) {
  const period = report.incomePeriods?.[operand.row?.statement]
  return fullAnnualPeriod(period?.current) && period.current.end === report.fiscalEnd ? period : null
}

function comparableAnnualPeriods(report, operand) {
  const period = annualIncomePeriod(report, operand)
  return period && fullAnnualPeriod(period.previous) &&
    Date.parse(period.current.start) - Date.parse(period.previous.end) === 86_400_000
}

function requireAnnualIncome(report, operand) {
  if (operand.status !== 'success' || annualIncomePeriod(report, operand)) return operand
  return invalid('unverified', 'annual-income-period-unverified', operand.evidence)
}

function family(report) {
  const separate = report.scope === 'OFS'
  return { net: separate ? 'netIncome' : 'parentNetIncome',
    opening: separate ? 'openingEquity' : 'openingParentEquity',
    closing: separate ? 'equity' : 'closingParentEquity',
    basis: separate ? 'separate-entity-net-income-and-equity' : 'consolidated-parent-attributable' }
}

const formulas = {
  per: ['multiple', 'issuer-market-cap / annual-net-income'],
  pbr: ['multiple', 'issuer-market-cap / closing-equity'],
  roe: ['percent', 'annual-net-income / ((opening-equity + closing-equity) / 2) * 100'],
  fcf: ['currency', 'operating-cash-flow - abs(ppe-acquisitions) - abs(intangible-acquisitions)'],
  debtRatio: ['percent', 'total-liabilities / total-equity * 100'],
  revenueGrowth: ['percent', '(annual-revenue - prior-comparable-annual-revenue) / prior-comparable-annual-revenue * 100'],
  operatingMargin: ['percent', 'operating-income / revenue * 100'],
  fcfMargin: ['percent', 'free-cash-flow / revenue * 100'],
  revenue: ['currency', 'reported-revenue'],
  operatingIncome: ['currency', 'reported-operating-income'],
  netIncome: ['currency', 'reported-net-income'],
}
const trendIds = ['revenue', 'operatingIncome', 'netIncome', 'roe', 'fcf', 'debtRatio', 'operatingMargin', 'revenueGrowth']
const quotient = (a, b) => [a, b]

function calculate(report, issuer, sector) {
  const basis = family(report)
  const net = account(report, basis.net)
  const annualNet = requireAnnualIncome(report, net)
  const closing = account(report, basis.closing)
  const marketAmount = issuer && decimal(issuer.value)
  const cap = issuer?.status === 'success' && !marketAmount
    ? invalid('not-calculable', 'issuer-cap-precision-limit', issuer.evidence)
    : issuer && { ...issuer, amount: marketAmount }
  const revenue = account(report, 'revenue')
  const operatingIncome = account(report, 'operatingIncome')
  const sectorRestriction = sector === 'financial-insurance' ? invalid('not-applicable', 'financial-insurance-sector')
    : sector !== 'non-financial' ? invalid('unverified', 'sector-unverified') : null
  const fcf = sectorRestriction ?? freeCashFlow(report)
  const debt = sectorRestriction ?? ratio([account(report, 'liabilities'), account(report, 'equity')], quotient, 100, 'nonpositive-equity')
  const previousRevenue = account(report, 'revenue', 'previous')
  const revenueGrowth = !comparableAnnualPeriods(report, revenue)
    ? invalid('unverified', 'comparative-fiscal-period-unverified', [...revenue.evidence, ...previousRevenue.evidence])
    : ratio([revenue, previousRevenue], (current, previous) => [add(current, negate(previous)), previous], 100, 'nonpositive-prior-revenue')
  return {
    ...(cap && { per: ratio([cap, annualNet], quotient, 1, 'nonpositive-net-income'),
      pbr: ratio([cap, closing], quotient, 1, 'nonpositive-equity') }),
    roe: ratio([annualNet, account(report, basis.opening), closing], (profit, open, close) => [profit, add(open, close)], 200,
      'nonpositive-average-equity'),
    fcf, debtRatio: debt, revenueGrowth,
    operatingMargin: ratio([operatingIncome, revenue], quotient, 100, 'nonpositive-revenue'),
    fcfMargin: fcf.status === 'success' ? ratio([fcf, revenue], quotient, 100, 'nonpositive-revenue') : fcf,
    revenue, operatingIncome, netIncome: net,
  }
}

function selectedReports(financials, evaluationDate) {
  const candidates = new Map()
  const selections = new Map()
  const unavailable = new Map()
  const blocked = new Set()
  for (const report of financials.years ?? []) {
    if (!/^20\d{2}$/.test(report?.year ?? '') || report.period !== 'annual' || report.reportCode !== annualCode) continue
    if (report.status !== 'available') {
      if (!unavailable.has(report.year)) unavailable.set(report.year, 'annual-report-unavailable')
      continue
    }
    const { filedAt } = report.receipt ?? {}
    if (isDay(filedAt) && filedAt > evaluationDate) {
      unavailable.set(report.year, 'annual-report-not-verified-as-of')
      continue
    }
    if (!candidates.has(report.year)) candidates.set(report.year, [])
    candidates.get(report.year).push(report)
  }

  for (const [year, reports] of candidates) {
    const reject = reason => {
      blocked.add(year)
      unavailable.set(year, reason)
    }
    if (reports.some(report => !isDay(report.receipt?.filedAt))) {
      reject('annual-report-filing-date-unverified')
      continue
    }
    reports.sort((a, b) => b.receipt.filedAt.localeCompare(a.receipt.filedAt))
    const latest = reports.filter(report => report.receipt.filedAt === reports[0].receipt.filedAt)
    if (latest.some(report => typeof report.receipt.id !== 'string' || !receiptCode.test(report.receipt.id))) {
      reject('annual-report-receipt-unverified')
      continue
    }
    latest.sort((a, b) => b.receipt.id.localeCompare(a.receipt.id))
    const report = latest[0]
    const { fiscalEnd, receipt } = report
    if (!isDay(fiscalEnd) || fiscalEnd > receipt.filedAt || !['CFS', 'OFS'].includes(report.scope) ||
        !Array.isArray(report.accounts) || !Number.isFinite(Date.parse(report.collectedAt)) || !report.source ||
        (report.issuerCorpCode != null && report.issuerCorpCode !== financials.mapping.issuer.corpCode)) {
      reject('annual-report-not-verified-as-of')
      continue
    }
    if (latest.some(other => other.receipt.id === receipt.id &&
        (other.scope !== report.scope || other.fiscalEnd !== fiscalEnd ||
         JSON.stringify(other.accounts) !== JSON.stringify(report.accounts) ||
         JSON.stringify(other.incomePeriods) !== JSON.stringify(report.incomePeriods)))) {
      reject('conflicting-annual-report')
      continue
    }
    selections.set(year, report)
    unavailable.delete(year)
  }
  return { selections, unavailable, blocked }
}

function publicMetric(id, result, report, market, calculatedAt, mock) {
  const [unit, formula] = formulas[id]
  return { id, value: result.value ?? null, exactFraction: result.exact ?? null, unit,
    currency: unit === 'currency' ? result.currency ?? null : null, formula, formulaVersion: fundamentalFormulaVersion,
    evidence: result.evidence, fiscalEnd: report?.fiscalEnd ?? null, marketDate: market?.date ?? null,
    receipt: report?.receipt ?? null, scope: report?.scope ?? null, basis: report ? family(report).basis : null,
    sources: { financial: report?.source ?? null, financialCollectedAt: report?.collectedAt ?? null,
      market: market?.sources ?? [] }, calculatedAt,
    status: result.status !== 'success' ? result.status : mock ? 'mock' : report?.snapshotStale ? 'stale' : 'success',
    reason: result.status === 'success' && report?.snapshotStale ? 'financial-snapshot-expired' : result.reason }
}

export function calculateFundamentals({ evaluationDate, financials, market, mode = 'observed' }, clock = Date.now) {
  if (!isDay(evaluationDate)) throw new TypeError('A valid evaluation date is required')
  const calculatedAt = new Date(clock()).toISOString()
  const mock = mode === 'mock'
  const mapping = financials?.mapping ?? null
  const mappingReady = mapping?.status === 'exact-code' && issueKey(mapping.issue) && issuerCode.test(mapping.issuer?.corpCode ?? '') &&
    isDay(mapping.issueAsOf) && mapping.issueAsOf <= evaluationDate
  const { issue, issuer } = aggregateMarket(market, mapping, evaluationDate)
  const { selections, unavailable, blocked } = mappingReady ? selectedReports(financials, evaluationDate)
    : { selections: new Map(), unavailable: new Map(), blocked: new Set() }
  const latestYear = [...selections.keys(), ...blocked].sort().at(-1)
  const latest = selections.get(latestYear)
  const firstYear = Math.max(Number(evaluationDate.slice(0, 4)) - 1, Number(latestYear ?? 0))
  const unverified = invalid('unverified', 'issuer-mapping-unverified')
  const unavailableFor = year => !mappingReady ? unverified : unavailable.has(year) && unavailable.get(year) !== 'annual-report-unavailable'
    ? invalid('unverified', unavailable.get(year)) : missing('annual-report-unavailable')
  const marketEvidence = [...issuer.evidence, ...issuer.candidates.flatMap(candidate => candidate.evidence), ...issue.evidence]
  const marketDates = [...new Set(marketEvidence.map(row => row.tradingDate).filter(Boolean))]
  const marketMetadata = { date: marketDates.length === 1 ? marketDates[0] : null,
    sources: [...new Set(marketEvidence.map(row => row.source).filter(Boolean))] }
  const values = latest ? calculate(latest, issuer, mapping.sector) : {}
  const trend = Array.from({ length: 3 }, (_, index) => String(firstYear - 2 + index)).map(year => {
    const report = selections.get(year)
    const metrics = report ? calculate(report, null, mapping.sector) : {}
    return { year, metrics: trendIds.map(id => publicMetric(id, metrics[id] ?? unavailableFor(year), report, null, calculatedAt, mock)) }
  })
  const publicCap = result => ({ ...result, value: result.value ?? null,
    status: mock && result.status === 'success' ? 'mock' : result.status })
  return { version: fundamentalFormulaVersion, evaluationDate, calculatedAt, mode, mapping,
    market: { currency: issuer.currency, issuer: publicCap(issuer), issue: publicCap(issue) },
    metrics: ['per', 'pbr', 'roe', 'fcf', 'debtRatio', 'revenueGrowth', 'operatingMargin', 'fcfMargin'].map(id =>
      publicMetric(id, values[id] ?? unavailableFor(latestYear ?? String(firstYear)), latest,
        ['per', 'pbr'].includes(id) ? marketMetadata : null, calculatedAt, mock)),
    trend }
}
