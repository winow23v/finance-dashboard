import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { calculateFundamentals } from './fundamental-ratios-provider.mjs'
import { createFundamentalsProvider } from './fundamentals-provider.mjs'
import { createDartFinancialCollector } from './dart-financials-provider.mjs'
import { dartFiscalDates, normalizeDartAccounts } from './dart-accounts-provider.mjs'
import { createKrxProvider } from './krx-provider.mjs'
import { buildApp } from './server.mjs'

const date = '2026-11-27'
const clock = () => Date.parse(date + 'T12:00Z')
const corpCode = '99900001'
const issue = { symbol: '005930', market: 'KOSPI', isin: 'KR7005930003', shareClass: '보통주', asOf: '2023-11-27' }
const preferred = { symbol: '005935', market: 'KOSPI', isin: 'KR7005931001', shareClass: '우선주' }
const listing = (base, marketCap) => ({ ...base, corpCode, mappingStatus: 'verified', marketCap,
  source: 'KRX OPEN API', tradingDate: date, listedShares: 1, close: 1 })
const account = (id, value, previous, fields = {}) => {
  const isBalance = ['closingParentEquity', 'equity', 'liabilities', 'parentEquity'].includes(id)
  const isOpening = id.startsWith('opening')
  const isCash = id === 'operatingCashFlow' || id.endsWith('Acquisitions')
  const amount = value => ({ value: value == null ? null : String(value), status: value == null ? 'missing' : 'reported' })
  return { id, current: amount(value), previous: amount(previous), quality: value == null ? 'missing' : 'reported',
    basis: isBalance ? 'point-in-time' : isOpening ? 'opening-balance' : 'annual',
    statement: isBalance ? 'BS' : isOpening ? 'SCE' : isCash ? 'CF' : 'IS',
    original: { accountId: 'fixture_' + id, name: id }, currency: 'KRW', unit: 'currency-unit', ...fields }
}
const report = (year, changes = {}) => ({
  year: String(year), status: 'available', period: 'annual', reportCode: '11011', scope: 'CFS',
  fiscalEnd: year + '-12-31', receipt: { id: (year + 1) + '0328000001', filedAt: (year + 1) + '-03-28' },
  collectedAt: '2026-11-26T00:00:00Z', source: 'synthetic-dart',
  incomePeriods: { IS: { current: { start: year + '-01-01', end: year + '-12-31' },
    previous: { start: (year - 1) + '-01-01', end: (year - 1) + '-12-31' } } },
  accounts: [
    account('revenue', 120, 100), account('operatingIncome', 24), account('parentNetIncome', 20), account('netIncome', 50),
    account('closingParentEquity', 100), account('openingParentEquity', 60), account('equity', 200), account('liabilities', 70),
    account('operatingCashFlow', 30), account('propertyPlantEquipmentAcquisitions', -11), account('intangibleAcquisitions', 7),
  ], ...changes,
})
function input() {
  return { evaluationDate: date, financials: { mapping: { issue, issueAsOf: issue.asOf, status: 'exact-code',
    issuer: { corpCode, name: 'synthetic' }, sector: 'non-financial' }, years: [report(2025), report(2024), report(2023)] },
  market: { currency: 'KRW', coverage: { status: 'verified', corpCode, asOf: date, issues: [issue, preferred] },
    issues: [listing(issue, 180), listing(preferred, 20)] } }
}
const byId = list => Object.fromEntries(list.map(metric => [metric.id, metric]))
const compute = data => byId(calculateFundamentals(data, clock).metrics)
function replace(data, id, value) {
  const accounts = data.financials.years[0].accounts
  const index = accounts.findIndex(row => row.id === id)
  if (index < 0) accounts.push(value)
  else if (value) accounts[index] = value
  else accounts.splice(index, 1)
}

test('calculates issuer and annual metrics with independent expected values and separates the issue cap', () => {
  const result = calculateFundamentals(input(), clock)
  assert.equal(result.market.issuer.value, '200')
  assert.equal(result.market.issue.value, '180')
  const metrics = byId(result.metrics)
  const expected = { per: '10', pbr: '2', roe: '25', fcf: '12', debtRatio: '35',
    revenueGrowth: '20', operatingMargin: '20', fcfMargin: '10' }
  assert.deepEqual(Object.fromEntries(result.metrics.map(({ id, value }) => [id, value])), expected)
  assert.ok(result.metrics.every(metric => metric.status === 'success'))
  assert.deepEqual(metrics.fcf.evidence.map(row => [row.amount, row.normalizedOutflow]), [['30', undefined], ['-11', '11'], ['7', '7']])
  assert.equal(metrics.per.marketDate, date)
  assert.equal(metrics.per.fiscalEnd, '2025-12-31')
  assert.equal(metrics.per.receipt.id, '20260328000001')
  assert.equal(metrics.per.evidence.at(-1).id, 'parentNetIncome')
  assert.equal(metrics.pbr.evidence.at(-1).id, 'closingParentEquity')
  assert.deepEqual(result.trend.map(item => item.year), ['2023', '2024', '2025'])
  assert.ok(result.trend.every(point => !byId(point.metrics).per && !byId(point.metrics).pbr))
  assert.equal(byId(result.trend[2].metrics).netIncome.value, '20')
})

test('handles loss, zero and negative denominators without substituting parent or total values', () => {
  const data = input()
  replace(data, 'parentNetIncome', account('parentNetIncome', -20))
  replace(data, 'closingParentEquity', account('closingParentEquity', -10))
  replace(data, 'equity', account('equity', -90))
  replace(data, 'operatingCashFlow', account('operatingCashFlow', -5))
  replace(data, 'operatingIncome', account('operatingIncome', -24))
  const metrics = compute(data)
  assert.deepEqual([metrics.per.reason, metrics.pbr.reason, metrics.debtRatio.reason],
    ['nonpositive-net-income', 'nonpositive-equity', 'nonpositive-equity'])
  assert.deepEqual([metrics.roe.value, metrics.fcf.value, metrics.operatingMargin.value], ['-80', '-23', '-20'])
  assert.equal(metrics.roe.status, 'success')
  assert.equal(metrics.fcf.status, 'success')
  replace(data, 'parentNetIncome', null)
  assert.equal(compute(data).per.status, 'missing-data')
  replace(data, 'parentNetIncome', account('parentNetIncome', 0))
  assert.equal(compute(data).per.reason, 'nonpositive-net-income')
})

test('keeps missing opening equity and CAPEX unavailable, and uses actual zero CAPEX', () => {
  const data = input()
  replace(data, 'openingParentEquity', null)
  replace(data, 'intangibleAcquisitions', account('intangibleAcquisitions', null))
  let metrics = compute(data)
  assert.equal(metrics.roe.status, 'missing-data')
  assert.equal(metrics.fcf.status, 'missing-data')
  assert.equal(metrics.fcfMargin.status, 'missing-data')
  replace(data, 'intangibleAcquisitions', account('intangibleAcquisitions', 0))
  metrics = compute(data)
  assert.equal(metrics.fcf.value, '19')
  replace(data, 'intangibleAcquisitions', account('intangibleAcquisitions', 11, null,
    { original: { accountId: 'fixture_propertyPlantEquipmentAcquisitions', name: 'duplicate' } }))
  assert.equal(compute(data).fcf.reason, 'duplicate-capex-source')
  data.financials.years[0].accounts.push(account('propertyPlantEquipmentAcquisitions', 11))
  assert.equal(compute(data).fcf.reason, 'duplicate-account')
})

test('does not mix scopes, currencies or non-comparable revenue periods and labels separate-entity values', () => {
  const data = input()
  replace(data, 'parentNetIncome', account('parentNetIncome', 20, null, { currency: 'USD' }))
  assert.equal(compute(data).per.reason, 'currency-mismatch')
  replace(data, 'parentNetIncome', account('parentNetIncome', 20, null, { scope: 'OFS' }))
  assert.equal(compute(data).per.reason, 'account-scope-or-statement-mismatch')
  data.financials.years[0].scope = 'OFS'
  replace(data, 'openingEquity', account('openingEquity', 100))
  const metrics = compute(data)
  assert.equal(metrics.per.value, '4')
  assert.equal(metrics.pbr.value, '1')
  assert.equal(metrics.roe.exactFraction.numerator, '10000')
  assert.equal(metrics.roe.value, '33.333333333333333333333333')
  assert.equal(metrics.roe.basis, 'separate-entity-net-income-and-equity')
  data.financials.years[0].incomePeriods.IS.previous.start = '2024-06-01'
  assert.equal(compute(data).revenueGrowth.reason, 'comparative-fiscal-period-unverified')
  data.financials.years[0].incomePeriods.IS.previous.start = '2024-01-01'
  replace(data, 'revenue', account('revenue', 120, 0))
  assert.equal(compute(data).revenueGrowth.reason, 'nonpositive-prior-revenue')
})

test('aggregates only a fully verified issue set and deduplicates identical observations', () => {
  const data = input()
  data.market.issues.push({ ...data.market.issues[1] })
  data.market.coverage.issues.push({ ...preferred })
  assert.equal(compute(data).per.value, '10')
  data.market.issues[1].mappingStatus = 'unverified'
  assert.equal(compute(data).pbr.status, 'partial-coverage')
  data.market.issues = [listing(issue, 180), { ...listing(preferred, 20), tradingDate: '2026-11-26' }]
  assert.equal(compute(data).per.status, 'stale')
  data.market.issues[1].tradingDate = date
  data.market.issues[1].marketCap = null
  data.market.issues[1].close = 2
  data.market.issues[1].listedShares = 10
  assert.equal(compute(data).pbr.status, 'partial-coverage')
  data.market.issues[1].listedSharesVerified = true
  assert.equal(compute(data).pbr.value, '2')
  data.market.coverage.status = 'unverified'
  assert.equal(compute(data).per.value, null)
  data.financials.mapping.status = 'unverified'
  assert.equal(compute(data).roe.status, 'unverified')
})

test('uses only available receipts as of evaluation, never substitutes current cap into earlier dates', () => {
  const data = input()
  data.financials.years.push(report(2025, { receipt: { id: '20261201000002', filedAt: '2026-12-01' },
    accounts: [account('parentNetIncome', 40)] }))
  assert.equal(compute(data).per.value, '10')
  data.evaluationDate = '2026-12-02'
  data.market.coverage.asOf = data.evaluationDate
  assert.equal(compute(data).per.status, 'stale')
  data.market.issues = data.market.issues.map(row => ({ ...row, tradingDate: data.evaluationDate }))
  assert.equal(compute(data).per.value, '5')
  data.financials.years = [report(2025)]
  data.evaluationDate = '2026-01-01'
  const result = calculateFundamentals(data, clock)
  assert.equal(byId(result.metrics).roe.value, null)
  assert.equal(byId(result.trend.at(-1).metrics).roe.reason, 'annual-report-not-verified-as-of')
  assert.equal(byId(result.trend[0].metrics).roe.status, 'missing-data')
})

test('does not use an earlier receipt or year when a filed replacement has incomplete metadata', () => {
  const data = input()
  const amended = report(2025, { fiscalEnd: null, receipt: { id: '20261126000002', filedAt: '2026-11-26' } })
  data.financials.years.push(amended)
  const result = calculateFundamentals(data, clock)
  assert.equal(byId(result.metrics).per.status, 'unverified')
  assert.equal(byId(result.metrics).roe.value, null)
  assert.equal(byId(result.trend.at(-1).metrics).roe.status, 'unverified')
  assert.equal(byId(result.trend[0].metrics).roe.value, '25')
  amended.receipt.filedAt = '2026-11-28'
  assert.equal(compute(data).per.value, '10')
})

test('requires a verified full annual income period for PER and ROE with the matching statement', () => {
  const data = input()
  const periods = data.financials.years[0].incomePeriods
  periods.IS.current.start = '2025-07-01'
  assert.equal(compute(data).per.reason, 'annual-income-period-unverified')
  assert.equal(compute(data).roe.reason, 'annual-income-period-unverified')
  assert.equal(compute(data).pbr.value, '2')
  replace(data, 'parentNetIncome', account('parentNetIncome', 20, null, { statement: 'CIS' }))
  assert.equal(compute(data).roe.reason, 'annual-income-period-unverified')
  periods.CIS = { current: { start: '2025-01-01', end: '2025-12-31' }, previous: null }
  assert.equal(compute(data).per.value, '10')
  assert.equal(compute(data).roe.value, '25')
})

test('computes exact decimals, labels mock inputs and handles financial-insurance applicability', () => {
  const data = input()
  replace(data, 'operatingCashFlow', account('operatingCashFlow', '9007199254740993.000000000000000001'))
  replace(data, 'propertyPlantEquipmentAcquisitions', account('propertyPlantEquipmentAcquisitions', '-0.000000000000000001'))
  replace(data, 'intangibleAcquisitions', account('intangibleAcquisitions', '0'))
  assert.equal(compute(data).fcf.value, '9007199254740993')
  data.mode = 'mock'
  assert.equal(compute(data).fcf.status, 'mock')
  data.financials.mapping.sector = 'financial-insurance'
  assert.equal(compute(data).fcf.status, 'not-applicable')
  assert.equal(compute(data).fcfMargin.status, 'not-applicable')
  assert.equal(compute(data).debtRatio.status, 'not-applicable')
  assert.equal(compute(data).roe.status, 'mock')
  data.mode = 'observed'
  data.financials.years[0].snapshotStale = true
  assert.equal(compute(data).roe.status, 'stale')
})

test('merges concurrent reads and invalidates calculations on receipts and same-receipt content changes', async () => {
  const data = input()
  let reads = 0
  const query = createFundamentalsProvider({ clock, readFinancials: async () => { reads++; return data.financials },
    readMarket: async () => data.market })
  const [a, b] = await Promise.all([query(issue.symbol, date), query(issue.symbol, date)])
  assert.deepEqual(a, b)
  assert.equal(reads, 1)
  assert.equal(byId(a.metrics).per.value, '10')
  replace(data, 'parentNetIncome', account('parentNetIncome', 25))
  assert.equal(byId((await query(issue.symbol, date)).metrics).per.value, '8')
  data.financials.years[0].receipt = { id: '20261126000002', filedAt: '2026-11-26' }
  assert.equal(byId((await query(issue.symbol, date)).metrics).per.receipt.id, '20261126000002')
  data.market.issues[0].marketCap = 230
  assert.equal(byId((await query(issue.symbol, date)).metrics).per.value, '10')
})

test('reads official fiscal bounds and OFS opening equity without importing CFS opening amounts', () => {
  const context = { corpCode, stockCode: issue.symbol, scope: 'OFS', receipt: '20260328000001',
    year: '2025', reportCode: '11011', period: 'annual' }
  const row = { rcept_no: context.receipt, fs_div: context.scope, stock_code: context.stockCode,
    bsns_year: context.year, reprt_code: context.reportCode }
  assert.deepEqual(dartFiscalDates([
    { ...row, sj_div: 'BS', thstrm_dt: '2025.12.31 현재' },
    { ...row, sj_div: 'IS', thstrm_dt: '2025.01.01 ~ 2025.12.31', frmtrm_dt: '2024.01.01 ~ 2024.12.31' },
  ], context), { fiscalEnd: '2025-12-31', incomePeriods: report(2025).incomePeriods })
  const dates = dartFiscalDates([
    { ...row, sj_div: 'CIS', thstrm_dt: '2025.01.01 ~ 2025.12.31', frmtrm_dt: '2024.01.01 ~ 2024.12.31' },
    { ...row, sj_div: 'IS', thstrm_dt: '2025.07.01 ~ 2025.12.31' },
    { ...row, sj_div: 'IS', thstrm_dt: '2025.01.01 ~ 2025.12.31' },
  ], context)
  assert.deepEqual(dates.incomePeriods, { CIS: report(2025).incomePeriods.IS })
  const sce = { ...row, corp_code: corpCode, sj_div: 'SCE', account_nm: '기초자본',
    account_id: 'dart_EquityAtBeginningOfPeriod', currency: 'KRW', thstrm_amount: '12' }
  const normalized = normalizeDartAccounts([
    { ...sce, account_detail: '자본 [member]' },
    { ...sce, account_detail: '자본 [member]|지배기업 소유주지분', thstrm_amount: '14' },
  ], context)
  assert.equal(normalized.accounts.find(item => item.id === 'openingEquity').current.value, '12')
  assert.equal(normalized.accounts.find(item => item.id === 'openingParentEquity').reason, 'scope-not-applicable')
})

test('approved admin route reads existing files only; old snapshots without identity cannot drive ratios', async t => {
  const root = await mkdtemp(join(tmpdir(), 'finance-fundamentals-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const data = input()
  const year = data.financials.years[0].year
  const snapshot = join(root, issue.symbol + '-' + (Number(year) % 3) + '.json')
  const localIssue = { ...issue, asOf: date }
  const store = mapping => writeFile(snapshot, JSON.stringify({ version: 1, corpCode, year,
    savedAt: clock(), mapping, statement: data.financials.years[0] }))
  await store(undefined)
  await writeFile(join(root, 'sto-stk_isu_base_info.json'), JSON.stringify({ version: 1, history: [],
    data: { date, rows: [{ ...localIssue, listedOn: issue.asOf }] } }))
  await writeFile(join(root, 'sto-stk_bydd_trd.json'), JSON.stringify({ version: 1, history: [],
    data: { date, rows: [{ ...listing(issue, 180), price: 100 }] } }))
  const never = () => assert.fail('read-only calculation must not contact upstream')
  const krx = createKrxProvider({ root, key: 'secret-fixture', scheduledOnly: true, clock, fetchImpl: never })
  const dart = async () => ({})
  dart.collectFinancials = createDartFinancialCollector({ root, clock, issueFor: krx.cachedIssue, catalog: never,
    requestRows: never, source: 'fixture' })
  const auth = { approved: false, admin: false }
  const app = await buildApp({ dart, memberKrx: krx, logger: false,
    membership: { verify: () => ({ id: 'fixture' }), read: () => ({ status: auth.approved ? 'approved' : 'pending' }),
      isAdmin: () => auth.admin } })
  t.after(() => app.close())
  const url = '/api/v1/financials/kr/005930/fundamentals?asOf=' + date
  const headers = { authorization: 'Bearer a.b.c' }
  assert.equal((await app.inject(url)).statusCode, 401)
  assert.equal((await app.inject({ url, headers })).statusCode, 403)
  auth.approved = true
  assert.equal((await app.inject({ url, headers })).statusCode, 403)
  auth.admin = true
  // Fixed application clock for HTTP tests is not configurable; the injected date must be in the past.
  const result = await app.inject({ url, headers })
  assert.equal(result.statusCode, 200)
  assert.equal(result.json().mapping.reason, 'snapshot-identity-unverified')
  await store({ ...data.financials.mapping, issue: localIssue, issueAsOf: date })
  const complete = await app.inject({ url, headers })
  assert.equal(complete.statusCode, 200)
  const body = complete.json()
  assert.equal(body.market.issue.value, '180')
  assert.equal(byId(body.metrics).per.status, 'partial-coverage')
  assert.equal(byId(body.metrics).roe.value, '25')
  assert.ok(!complete.body.includes('secret-fixture'))
  assert.equal((await app.inject({ url: url.replace(date, '2026-02-31'), headers })).statusCode, 400)
})
