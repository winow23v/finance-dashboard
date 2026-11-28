import assert from 'node:assert/strict'
import { mkdir, mkdtemp, open, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { test } from 'node:test'
import { zipSync, strToU8 } from 'fflate'
import { normalizeDartAccounts } from './dart-accounts-provider.mjs'
import { createDartFinancialCollector, dartIssueMapping } from './dart-financials-provider.mjs'
import { createDartProvider } from './dart-provider.mjs'
import { createKrxProvider } from './krx-provider.mjs'
import { ProviderError } from './public-provider.mjs'
import { buildApp } from './server.mjs'

const now = Date.parse('2026-11-27T12:00Z')
const receipt = '20260401000002'
const corpCode = '99990001'
const year = '2025'
const reportCode = '11011'
const options = { corpCode, year, period: 'annual', reportCode, scope: 'CFS' }
const row = (account_id, account_nm, sj_div, thstrm_amount, extra) => ({
  corp_code: corpCode, bsns_year: year, reprt_code: reportCode, rcept_no: receipt,
  account_id, account_nm, sj_div, thstrm_amount, currency: 'KRW', ...extra,
})
const byId = result => Object.fromEntries(result.accounts.map(account => [account.id, account]))

test('normalizes exact accounts and decimals across statement types without merging subtotals or versions', () => {
  const revenue = row('ifrs-full_Revenue', 'Fixture', 'IS', '9,007,199,254,740,993.0100')
  const accounts = byId(normalizeDartAccounts([
    revenue, revenue, row('ext_Revenue', '매출액', 'IS', '12'),
    row('ifrs-full_Revenue', '매출액', 'IS', '20', { rcept_no: '20260331000001' }),
    row('dart_OperatingIncomeLoss', '영업손실', 'CIS', '-20'),
    row('ifrs-full_ProfitLoss', '당기순이익', 'IS', '0'),
    row('ifrs-full_ProfitLossAttributableToOwnersOfParent', '당기순이익', 'IS', '-1'),
    row('ifrs-full_Assets', '자산총계', 'BS', '100', { frmtrm_amount: '90' }),
    row('ifrs-full_Liabilities', '부채총계', 'BS', '30'),
    row('ifrs-full_Equity', '자본총계', 'BS', '70'),
    row('ifrs-full_EquityAttributableToOwnersOfParent', '지배기업 소유주지분', 'BS', '25', { frmtrm_amount: '24' }),
    row('dart_EquityAtBeginningOfPeriod', '기초자본', 'SCE', '23', {
      account_detail: '자본 [member]|지배기업 소유주지분', frmtrm_amount: '21',
    }),
    row('dart_EquityAtBeginningOfPeriod', '기초자본', 'SCE', '99', {
      account_detail: '자본 [member]|지배기업 소유주지분|기타',
    }),
    row('ext_OperatingCashFlow', '영업활동으로 인한 현금흐름', 'CF', '50'),
    row('ext_PPE', '유형자산의 취득', 'CF', '-3'),
    row('ext_PPE2', '유형자산 취득', 'CF', '-2'),
    row('', '무형자산의 취득', 'CF', '0'),
  ], options))
  assert.equal(accounts.revenue.current.value, '9007199254740993.0100')
  assert.equal(accounts.revenue.mapping, 'standard-id')
  assert.equal(accounts.operatingIncome.current.value, '-20')
  assert.equal(accounts.netIncome.current.value, '0')
  assert.equal(accounts.parentNetIncome.current.value, '-1')
  assert.equal(accounts.assets.previous.value, '90')
  assert.equal(accounts.openingParentEquity.current.value, '23')
  assert.equal(accounts.closingParentEquity.current.value, '25')
  assert.equal(accounts.equity.current.value, '70')
  assert.equal(accounts.operatingCashFlow.mapping, 'exact-alias')
  assert.equal(accounts.propertyPlantEquipmentAcquisitions.reason, 'conflicting-accounts')
  assert.equal(accounts.propertyPlantEquipmentAcquisitions.current.value, null)
  assert.equal(accounts.intangibleAcquisitions.current.value, '0')
  assert.throws(() => normalizeDartAccounts([{ ...revenue, fs_div: 'OFS' }], options), ProviderError)
})

test('distinguishes missing, invalid, signed and cumulative values using the source period and scope', () => {
  const quarterly = { ...options, period: 'half', reportCode: '11012', scope: 'OFS' }
  const context = { fs_div: 'OFS', reprt_code: '11012' }
  const accounts = byId(normalizeDartAccounts([
    row('ifrs-full_Revenue', '매출액', 'IS', '3', { ...context, thstrm_add_amount: '5', frmtrm_q_amount: '2', frmtrm_add_amount: '4' }),
    row('dart_OperatingIncomeLoss', '영업이익', 'IS', '10', context),
    row('', '유형자산의 취득', 'CF', '-15', { ...context, frmtrm_q_amount: '-7', frmtrm_amount: '-90' }),
    row('', '무형자산의 취득', 'CF', 'not a number', context),
  ], quarterly))
  assert.equal(accounts.revenue.basis, 'year-to-date')
  assert.deepEqual([accounts.revenue.current.value, accounts.revenue.previous.value, accounts.revenue.reportedQuarter.current.value],
    ['5', '4', '3'])
  assert.equal(accounts.operatingIncome.current.status, 'missing')
  assert.equal(accounts.propertyPlantEquipmentAcquisitions.current.value, '-15')
  assert.equal(accounts.propertyPlantEquipmentAcquisitions.previous.value, '-7')
  assert.equal(accounts.intangibleAcquisitions.current.status, 'invalid')
  assert.equal(accounts.parentNetIncome.reason, 'scope-not-applicable')
})

const samples = [
  ['005930', 'KOSPI', '보통주'], ['005935', 'KOSPI', '우선주'], ['373220', 'KOSPI', '보통주'],
  ['263860', 'KOSDAQ', '보통주'], ['150900', 'KOSDAQ', '보통주'], ['001450', 'KOSPI', '보통주'],
]
const catalog = samples.filter(([symbol]) => symbol !== '005935').map(([ticker], i) =>
  ({ ticker, id: String(99990001 + i), name: '비식별 발행사 ' + i }))
const issueFor = symbol => {
  const sample = samples.find(([ticker]) => symbol === ticker)
  return sample ? { symbol, market: sample[1], shareClass: sample[2], name: '유사한 이름', asOf: '2026-11-26', isin: null } : null
}

test('maps five exact code fixtures and leaves the preferred issue separate; ambiguous exact matches stay unresolved', () => {
  for (const [symbol] of samples) {
    const mapping = dartIssueMapping(issueFor(symbol), catalog, new Date(now).toISOString())
    assert.equal(mapping.issue.symbol, symbol)
    assert.equal(mapping.status, symbol === '005935' ? 'unverified' : 'exact-code')
    if (symbol === '001450') assert.equal(mapping.sector, 'financial-insurance')
  }
  const mapping = dartIssueMapping(issueFor('005935'), [{ ...catalog[0], name: '유사한 이름' }], null)
  assert.equal(mapping.issuer, null)
  assert.equal(mapping.issue.shareClass, '우선주')
  assert.equal(dartIssueMapping(issueFor('005930'), [...catalog, { ...catalog[0], id: '99990123' }], null).reason,
    'ambiguous-corp-code')
})

test('collects three annual slots sequentially, resumes after failure, and reuses versioned cache across restarts', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dart-financials-resume-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const calls = []
  let failed = true
  const requestRows = async (path, params) => {
    calls.push([path, params.bsns_year, params.fs_div])
    if (path === 'list.json') return [{ corp_code: corpCode, rcept_no: receipt, rcept_dt: '20260401', report_nm: '[기재정정]사업보고서' }]
    if (path === 'fnlttSinglAcnt.json') return [
      { stock_code: '999999', rcept_no: receipt, bsns_year: year, reprt_code: reportCode,
        fs_div: 'CFS', sj_div: 'BS', thstrm_dt: '2025.09.30 현재' },
      { stock_code: '005930', rcept_no: receipt, bsns_year: year, reprt_code: reportCode,
        fs_div: 'CFS', sj_div: 'BS', thstrm_dt: '2025.12.31 현재' },
    ]
    if (params.bsns_year === '2025') return [row('ifrs-full_Revenue', '매출액', 'IS', '9')]
    if (params.bsns_year === '2024' && params.fs_div === 'OFS') {
      if (failed) throw new ProviderError(503, 'DART_PROVIDER_LIMITED')
      return [row('ifrs-full_Equity', '자본총계', 'BS', '8', { bsns_year: '2024', fs_div: 'OFS', rcept_no: '20250331000001' })]
    }
    return []
  }
  const options = { root, issueFor, requestRows, clock: () => now, source: 'fixture', catalog: async () => catalog }
  const collect = createDartFinancialCollector(options)
  const [partial, duplicate] = await Promise.all([collect('005930'), collect('005930')])
  assert.deepEqual(partial, duplicate)
  assert.deepEqual(partial.progress, { status: 'partial', failedYear: '2024', reason: 'DART_PROVIDER_LIMITED' })
  assert.equal(partial.years[0].receipt.amendment, 'amended')
  assert.equal(partial.years[0].receipt.filedAt, '2026-04-01')
  assert.equal(partial.years[0].fiscalEnd, '2025-12-31')
  assert.equal(calls.filter(call => call[1] === '2025').length, 2)
  failed = false
  calls.length = 0
  const resumed = await createDartFinancialCollector(options)('005930')
  assert.deepEqual(resumed.years.map(({ year, scope, status, cache }) => [year, scope, status, cache]), [
    ['2025', 'CFS', 'available', 'hit'], ['2024', 'OFS', 'available', 'updated'], ['2023', null, 'not-provided', 'updated'],
  ])
  assert.ok(!calls.some(call => call[1] === '2025'))
  assert.deepEqual((await readdir(root)).sort(), ['005930-0.json', '005930-1.json', '005930-2.json'])
  calls.length = 0
  await createDartFinancialCollector(options)('005930')
  assert.equal(calls.length, 0)
  await assert.rejects(collect('000660'), { code: 'DART_FINANCIAL_SAMPLE_NOT_FOUND' })
})

test('creates a private cache and saves private snapshots with no temporary files left', async t => {
  const parent = await mkdtemp(join(tmpdir(), 'dart-financials-private-'))
  t.after(() => rm(parent, { recursive: true, force: true }))
  const root = join(parent, 'financials')
  const collect = createDartFinancialCollector({ root, issueFor, catalog: async () => catalog,
    requestRows: async () => [], clock: () => now })
  assert.equal((await collect('005930')).progress.status, 'complete')
  assert.equal((await stat(root)).mode & 0o777, 0o700)
  const files = await readdir(root)
  assert.equal(files.length, 3)
  for (const name of files) {
    assert.match(name, /^005930-[012]\.json$/)
    assert.equal((await stat(join(root, name))).mode & 0o777, 0o600)
  }
})

test('diagnoses cache failures without exposing paths or dispatching providers after a failed preflight', async t => {
  const faults = [
    ['directory-prepare', 'EROFS', 'mkdir', false],
    ['directory-prepare', 'EACCES', 'mkdir', false],
    ['temporary-write', 'EPERM', 'probe-open', false],
    ['temporary-write', 'ENOSPC', 'probe-write', false],
    ['read', 'EACCES', 'read', false],
    ['temporary-write', 'ENOSPC', 'snapshot-write', true],
    ['rename', 'EPERM', 'rename', true],
  ]
  for (const [stage, code, fault, expectProviders] of faults) {
    await t.test(fault + ' ' + code, async t => {
      const root = await mkdtemp(join(tmpdir(), 'dart-financials-fault-'))
      t.after(() => rm(root, { recursive: true, force: true }))
      const failure = Object.assign(new Error('private path ' + root), { code, path: root })
      const events = []
      const calls = []
      const cacheFs = {
        mkdir: fault === 'mkdir' ? async () => { throw failure } : mkdir,
        unlink,
        rename: fault === 'rename' ? async () => { throw failure } : rename,
        async open(path, flags, mode) {
          const probe = path.includes('.probe-')
          if ((probe && fault === 'probe-open') || (flags === 'r' && fault === 'read')) throw failure
          const file = await open(path, flags, mode)
          if ((probe && fault === 'probe-write') || (flags === 'wx' && !probe && fault === 'snapshot-write')) {
            file.writeFile = async () => { throw failure }
          }
          return file
        },
      }
      const collect = createDartFinancialCollector({ root, cacheFs, logCacheError: entry => events.push(entry),
        issueFor: symbol => { calls.push('krx'); return issueFor(symbol) },
        catalog: async () => { calls.push('catalog'); return catalog },
        requestRows: async () => { calls.push('rows'); return [] }, clock: () => now })
      await assert.rejects(collect('005930'), error => {
        assert.equal(error.code, 'DART_FINANCIAL_CACHE_UNAVAILABLE')
        assert.equal(error.statusCode, 503)
        assert.ok(!JSON.stringify(error).includes(root))
        assert.ok(!error.message.includes(root))
        return true
      })
      assert.deepEqual(events, [{ event: 'dart-financial-cache-error', stage, osCode: code }])
      assert.deepEqual(calls, expectProviders ? ['krx', 'catalog', 'rows', 'rows'] : [])
      assert.deepEqual(await readdir(root), [])
    })
  }
})

test('returns the compatible admin HTTP cache error before any upstream request', async t => {
  const parent = await mkdtemp(join(tmpdir(), 'dart-financials-http-'))
  t.after(() => rm(parent, { recursive: true, force: true }))
  const file = join(parent, 'file')
  await writeFile(file, '')
  const key = 'private-fixture-key'
  const dart = createDartProvider({ key, financialRoot: join(file, 'cache'),
    issueFor: () => assert.fail('unexpected KRX call'), fetchImpl: () => assert.fail('unexpected DART call') })
  const app = await buildApp({ dart, logger: false, membership: {
    verify: () => ({ id: 'fixture' }), read: () => ({ status: 'approved' }), isAdmin: () => true,
  } })
  t.after(() => app.close())
  const response = await app.inject({ method: 'POST', url: '/api/v1/financials/kr/005930/collect',
    headers: { authorization: 'Bearer x.y.z' } })
  assert.equal(response.statusCode, 503)
  assert.equal(response.json().code, 'DART_FINANCIAL_CACHE_UNAVAILABLE')
  assert.ok(!response.body.includes(parent) && !response.body.includes(key))
})

test('only retries transient upstream failures once and reserves the remaining shared capacity', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dart-financials-budget-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  let calls = 0
  const collect = createDartFinancialCollector({ root, clock: () => now, issueFor, catalog: async () => catalog,
    requestRows: async () => {
      calls++
      throw new ProviderError(503, 'DART_UPSTREAM_TRANSIENT')
    },
  })
  for (let attempt = 0; attempt < 50; attempt++) {
    await assert.rejects(collect('005930'), { code: 'DART_UPSTREAM_TRANSIENT' })
  }
  assert.equal(calls, 100)
  await assert.rejects(collect('373220'), { code: 'DART_FINANCIAL_BUDGET_EXHAUSTED' })
  assert.equal(calls, 100)
})

test('protected sample route shares the catalog and supplier limiter without revealing the key', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dart-financials-api-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { ticker, id, name } = catalog[0]
  const archive = zipSync({ 'CORPCODE.xml': strToU8(
    `<result><list><corp_code>${id}</corp_code><corp_name>${name}</corp_name><stock_code>${ticker}</stock_code></list></result>`,
  ) })
  const key = 'hidden-dart-fixture-key'
  const calls = []
  const log = []
  const dart = createDartProvider({ key, clock: () => now, issueFor, financialRoot: root, fetchImpl: async value => {
    const url = new URL(value)
    assert.equal(url.searchParams.get('crtfc_key'), key)
    calls.push([url.pathname, performance.now()])
    if (url.pathname.endsWith('corpCode.xml')) return new Response(archive)
    return Response.json({ status: '020', message: key })
  } })
  let approved = false
  let admin = false
  const app = await buildApp({ dart, logger: { stream: new Writable({ write(chunk, _encoding, next) {
    log.push(String(chunk))
    next()
  } }) }, membership: {
    verify: () => ({ id: 'fixture' }), read: () => ({ status: approved ? 'approved' : 'pending' }),
    isAdmin: () => admin,
  } })
  t.after(() => app.close())
  const request = { method: 'POST', url: '/api/v1/financials/kr/005930/collect' }
  assert.equal((await app.inject(request)).statusCode, 401)
  request.headers = { authorization: 'Bearer x.y.z' }
  assert.equal((await app.inject(request)).statusCode, 403)
  approved = true
  assert.equal((await app.inject(request)).statusCode, 403)
  assert.equal(calls.length, 0)
  admin = true
  const legacy = await app.inject({ url: '/api/v1/disclosures/kr?q=005930', headers: request.headers })
  assert.deepEqual(legacy.json().companies, [catalog[0]])
  const result = await app.inject(request)
  assert.equal(result.statusCode, 503)
  assert.equal(result.json().code, 'DART_PROVIDER_LIMITED')
  assert.deepEqual(calls.map(([path]) => path), ['/api/corpCode.xml', '/api/fnlttSinglAcntAll.json'])
  assert.ok(calls[1][1] - calls[0][1] >= 995)
  assert.ok(!result.body.includes(key))
  assert.ok(!log.join('').includes(key))
})

test('reads KRX listing identity from the existing snapshot without fetching trades or the master', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dart-krx-cache-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'sto-stk_isu_base_info.json'), JSON.stringify({ version: 1, history: [], data: {
    date: '2026-11-26', rows: [{ symbol: '005935', isin: 'KR7005931001', name: '비식별 우선주', shareClass: '우선주' }],
  } }))
  const provider = createKrxProvider({ root, key: 'fixture', fetchImpl: () => assert.fail('unexpected KRX fetch') })
  assert.deepEqual(await provider.cachedIssue('005935'), {
    symbol: '005935', market: 'KOSPI', name: '비식별 우선주', shareClass: '우선주', isin: 'KR7005931001', asOf: '2026-11-26',
  })
  assert.equal(await provider.cachedIssue('005930'), null)
})
