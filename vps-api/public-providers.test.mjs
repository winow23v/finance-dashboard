import assert from 'node:assert/strict'
import { test } from 'node:test'
import { zipSync, strToU8 } from 'fflate'
import { buildApp } from './server.mjs'
import { createDartProvider } from './dart-provider.mjs'
import { createEcosProvider } from './ecos-provider.mjs'
import { createFxProvider } from './fx-provider.mjs'
import { createSecProvider } from './sec-provider.mjs'

async function appFor(t, providers) {
  const app = await buildApp({ logger: false, ...providers })
  t.after(() => app.close())
  return app
}

const fxRow = (date, quote, rate) => ({ date, base: 'EUR', quote, rate })
const date = '2026-04-02'
test('ECB holidays and weekends keep real observation dates, with same-day cross rates and shared cache', async t => {
  let calls = 0
  const fx = createFxProvider({
    clock: () => Date.parse('2026-04-05T12:00:00Z'),
    fetchImpl: async url => {
      calls++
      const query = new URL(url).searchParams
      assert.equal(query.get('providers'), 'ecb')
      assert.equal(query.get('from'), '2025-04-05')
      return Response.json([
        fxRow(date, 'JPY', 160), fxRow(date, 'USD', 1.25), fxRow(date, 'KRW', 1500),
        fxRow('2026-03-30', 'USD', 1.2), fxRow('2026-03-30', 'KRW', 1440),
        fxRow('2026-03-31', 'USD', 1.2),
        fxRow('2026-02-10', 'USD', 1.2), fxRow('2026-02-10', 'KRW', 1440),
      ])
    },
  })
  const app = await appFor(t, { fx })
  const [latest, history] = await Promise.all([
    app.inject('/api/v1/fx/latest'),
    app.inject('/api/v1/fx/history?base=USD&quote=KRW&period=1W'),
  ])
  assert.equal(latest.statusCode, 200)
  assert.equal(history.statusCode, 200)
  assert.equal(calls, 1)
  assert.deepEqual(latest.json().rates.map(row => [row.rate, row.observationDate, row.status, row.calculated]), [
    [1200, date, 'previous_publication', true],
    [1500, date, 'previous_publication', false],
    [128, date, 'previous_publication', true],
  ])
  assert.equal(history.json().from, '2026-03-30')
  assert.deepEqual(history.json().points.map(row => row.observationDate), ['2026-03-30', date])
  for (const [period, count] of [['1M', 2], ['3M', 3], ['1Y', 3]]) {
    const result = await app.inject(`/api/v1/fx/history?base=USD&quote=KRW&period=${period}`)
    assert.equal(result.json().points.length, count)
  }
  for (const path of [
    '/api/v1/fx/history?base=EUR&quote=JPY',
    '/api/v1/fx/history?base=GBP&quote=KRW',
    '/api/v1/fx/history?base=USD&quote=KRW&period=1D',
    '/api/v1/fx/latest?key=anything',
  ]) assert.equal((await app.inject(path)).statusCode, 400)
  assert.equal(calls, 1)
})

test('Frankfurter errors and schema changes produce sanitized provider statuses', async t => {
  for (const [response, status, code] of [
    [Response.json({}, { status: 429 }), 503, 'PROVIDER_RATE_LIMITED'],
    [Response.json({}, { status: 500 }), 502, 'PROVIDER_UNAVAILABLE'],
    [Response.json({ rates: [] }), 502, 'INVALID_PROVIDER_RESPONSE'],
    [Response.json([fxRow('2026-04-31', 'USD', 1.2)]), 502, 'INVALID_PROVIDER_RESPONSE'],
  ]) {
    const app = await appFor(t, { fx: createFxProvider({ fetchImpl: async () => response }) })
    const result = await app.inject('/api/v1/fx/latest')
    assert.equal(result.statusCode, status)
    assert.equal(result.json().code, code)
    assert.equal(result.headers['cache-control'], 'no-store')
  }
})

test('provider configuration and query errors are distinct and never call upstream', async t => {
  const fail = () => assert.fail('Unexpected upstream request')
  const app = await appFor(t, {
    ecos: createEcosProvider({ key: '', fetchImpl: fail }),
    dart: createDartProvider({ key: '', fetchImpl: fail }),
    sec: createSecProvider({ userAgent: '', fetchImpl: fail }),
  })
  for (const [path, code] of [
    ['/api/v1/economy/korea', 'ECOS_CONFIGURATION_MISSING'],
    ['/api/v1/disclosures/kr?q=005930', 'DART_CONFIGURATION_MISSING'],
    ['/api/v1/disclosures/us?q=0000320193', 'SEC_CONFIGURATION_MISSING'],
  ]) {
    const result = await app.inject(path)
    assert.equal(result.statusCode, 503)
    assert.equal(result.json().code, code)
  }
  for (const path of [
    '/api/v1/economy/korea?key=abc',
    '/api/v1/disclosures/kr?corpCode=00126380&year=2025',
    '/api/v1/disclosures/kr?q=삼성&period=q1',
    '/api/v1/disclosures/us?cik=0',
    '/api/v1/disclosures/us?cik=320193&q=AAPL',
  ]) assert.equal((await app.inject(encodeURI(path))).statusCode, 400)
})

test('ECOS validates the official series and preserves collection, observation, and release dates', async t => {
  const key = 'test-ecos-key'
  const ecos = createEcosProvider({ key, clock: () => Date.parse('2026-04-05T12:00:00Z'), fetchImpl: async url => {
    if (url.includes('/901Y009/')) return Response.json({ StatisticSearch: { row: [
      { STAT_CODE: '901Y009', ITEM_CODE1: '0', TIME: '202603', UNIT_NAME: '2020=100', DATA_VALUE: '120.5' },
    ] } })
    if (url.includes('/901Y027/')) {
      assert.match(url, /I61BC\/I28A$/)
      return Response.json({ StatisticSearch: { row: [
        { STAT_CODE: '901Y027', ITEM_CODE1: 'I61BC', ITEM_CODE2: 'I28A', TIME: '202603', UNIT_NAME: '%', DATA_VALUE: '3.1' },
      ] } })
    }
    assert.match(url, /\/722Y001\/D\/20260323\/20260405\/0101000$/)
    return Response.json({ StatisticSearch: { row: [
      { STAT_CODE: '722Y001', ITEM_CODE1: '0101000', TIME: '20260403', UNIT_NAME: '연%', DATA_VALUE: '2.5' },
    ] } })
  } })
  const app = await appFor(t, { ecos })
  const result = await app.inject('/api/v1/economy/korea')
  assert.equal(result.statusCode, 200)
  const [rate, cpi, unemployment] = result.json().indicators
  assert.equal(rate.value, 2.5)
  assert.equal(rate.observationDate, '2026-04-03')
  assert.equal(rate.releaseDate, null)
  assert.equal(rate.collectedAt, '2026-04-05T12:00:00.000Z')
  assert.deepEqual([cpi.value, unemployment.value], [120.5, 3.1])
  assert.equal(cpi.observationDate, null)
  assert.equal(cpi.observationPeriod, '2026-03')
  assert.equal(unemployment.agency.name, '국가데이터처 KOSIS')
  assert.ok(!result.body.includes(key))
})

test('each provider sanitizes supplier errors and secret-bearing messages', async t => {
  const key = 'test-sentinel-key'
  const app = await appFor(t, {
    ecos: createEcosProvider({ key, fetchImpl: async () => Response.json({ RESULT: { CODE: 'ERROR-100', MESSAGE: key } }) }),
    dart: createDartProvider({ key, fetchImpl: async () => new Response(`<?xml version="1.0"?><result><status>010</status><message>${key}</message></result>`) }),
    sec: createSecProvider({ userAgent: 'Example operator security@example.org', fetchImpl: async () => { throw new Error(key) } }),
  })
  for (const [path, code] of [
    ['/api/v1/economy/korea', 'ECOS_PROVIDER_ERROR'],
    ['/api/v1/disclosures/kr?q=005930', 'DART_PROVIDER_ERROR'],
    ['/api/v1/disclosures/us?q=AAPL', 'PROVIDER_UNAVAILABLE'],
  ]) {
    const result = await app.inject(path)
    assert.equal(result.statusCode, 502)
    assert.equal(result.json().code, code)
    assert.ok(!result.body.includes(key))
  }
})

test('DART maps the exact stock code, preserves corrections and labels consolidated and separate cumulative values', async t => {
  const corp = '00126380'
  const ticker = '005930'
  const id = '20260401000002'
  const key = 'test-dart-key'
  let catalogCalls = 0
  const archive = zipSync({ 'CORPCODE.xml': strToU8(`<?xml version="1.0"?><result>
    <list><corp_code>${corp}</corp_code><corp_name>삼성전자</corp_name><stock_code>${ticker}</stock_code></list>
    <list><corp_code>00123456</corp_code><corp_name>비상장</corp_name><stock_code> </stock_code></list></result>`) })
  const fetchImpl = async rawUrl => {
    const url = new URL(rawUrl)
    assert.equal(url.searchParams.get('crtfc_key'), key)
    if (url.pathname.endsWith('corpCode.xml')) {
      catalogCalls++
      return new Response(archive)
    }
    assert.equal(url.searchParams.get('corp_code'), corp)
    if (url.pathname.endsWith('list.json')) {
      assert.equal(url.searchParams.get('last_reprt_at'), 'N')
      assert.equal(url.searchParams.get('sort'), 'date')
      assert.equal(url.searchParams.get('sort_mth'), 'desc')
      const amendment = { corp_code: corp, rcept_dt: '20260401', rcept_no: id, report_nm: '[기재정정]분기보고서' }
      return Response.json({ status: '000', list: [amendment, amendment, { ...amendment, rcept_no: '20260331000001', report_nm: '분기보고서' }] })
    }
    if (url.searchParams.get('reprt_code') === '11011') return new Response(null, { status: 502 })
    assert.equal(url.searchParams.get('reprt_code'), '11013')
    assert.equal(url.searchParams.get('bsns_year'), '2025')
    const row = { corp_code: corp, stock_code: ticker, bsns_year: '2025', reprt_code: '11013',
      sj_div: 'IS', account_nm: '매출액', rcept_no: id, currency: 'KRW', thstrm_dt: '2025.01.01 ~ 2025.03.31',
      thstrm_amount: '10', thstrm_add_amount: '9007199254740993' }
    return Response.json({ status: '000', list: [
      { ...row, fs_div: 'CFS' }, { ...row, fs_div: 'OFS', thstrm_add_amount: '5' },
      { ...row, fs_div: 'CFS', account_nm: '영업이익', thstrm_add_amount: '-20' },
      { ...row, fs_div: 'CFS', account_nm: '당기순이익', thstrm_add_amount: '0' },
    ] })
  }
  const app = await appFor(t, { dart: createDartProvider({ key, fetchImpl }) })
  assert.deepEqual((await app.inject('/api/v1/disclosures/kr?q=005930')).json().companies, [{ id: corp, ticker, name: '삼성전자' }])
  const result = await app.inject(`/api/v1/disclosures/kr?corpCode=${corp}&year=2025&period=q1`)
  assert.equal(result.statusCode, 200)
  assert.ok(!result.body.includes(key))
  const body = result.json()
  assert.deepEqual(body.filings.map(row => row.amended), [true, false])
  assert.deepEqual(body.financials.map(row => [row.metric, row.statement, row.basis, row.value]), [
    ['revenue', 'consolidated', 'year-to-date', '9007199254740993'], ['revenue', 'separate', 'year-to-date', '5'],
    ['operatingIncome', 'consolidated', 'year-to-date', '-20'], ['netIncome', 'consolidated', 'year-to-date', '0'],
  ])
  assert.ok(body.financials.every(row => row.end === '2025-03-31'))
  const partial = await app.inject(`/api/v1/disclosures/kr?corpCode=${corp}&year=2025&period=annual`)
  assert.equal(partial.statusCode, 200)
  assert.deepEqual(partial.json().filings, body.filings)
  assert.deepEqual(partial.json().financials, [])
  assert.equal(partial.json().financialsError, 'PROVIDER_UNAVAILABLE')
  assert.equal(catalogCalls, 1)
})

test('SEC 403 blocks queued and later calls until a new request after cooldown', async t => {
  let now = 0
  let calls = 0
  const sec = createSecProvider({
    userAgent: 'Example operator security@example.org',
    clock: () => now,
    fetchImpl: async () => {
      calls++
      if (calls === 1) {
        await new Promise(resolve => setTimeout(resolve, 25))
        return new Response('upstream details', { status: 403 })
      }
      return Response.json({})
    },
  })
  const app = await appFor(t, { sec })
  const search = '/api/v1/disclosures/us?q=AAPL'
  const detail = '/api/v1/disclosures/us?cik=320193'
  const responses = await Promise.all([app.inject(search), app.inject(detail)])
  now = 60 * 60_000 - 1
  responses.push(await app.inject(search))
  for (const response of responses) {
    assert.equal(response.statusCode, 503)
    assert.equal(response.json().code, 'SEC_ACCESS_RESTRICTED')
    assert.ok(!response.body.includes('upstream details'))
  }
  assert.equal(calls, 1)
  now++
  assert.equal((await app.inject(search)).statusCode, 200)
  assert.equal(calls, 2)
})

test('SEC identifies requests and selects only the matching USD filing and standalone fiscal quarter', async t => {
  const cik = 320193
  const userAgent = 'Example operator security@example.org'
  const accession = '0000320193-26-000078'
  const filed = '2026-08-01'
  const end = '2026-06-27'
  const row = { accn: accession, filed, end, start: '2026-03-29', form: '10-Q', val: 217 }
  const starts = []
  const sec = createSecProvider({ userAgent, fetchImpl: async (url, options) => {
    starts.push(performance.now())
    assert.equal(options.headers['User-Agent'], userAgent)
    if (url.includes('company_tickers')) return Response.json({ 0: { cik_str: cik, ticker: 'AAPL', title: 'Apple Inc.' } })
    if (url.includes('submissions')) return Response.json({ cik: '0000320193', name: 'Apple Inc.', filings: { recent: {
      form: ['10-Q'], accessionNumber: [accession], filingDate: [filed], reportDate: [end], primaryDocument: ['aapl.htm'],
    } } })
    return Response.json({ cik, facts: { 'us-gaap': { Revenues: { units: {
      USD: [row, { ...row, start: '2025-09-28', val: 999 }, { ...row, accn: 'unrelated', val: 1000 }],
      EUR: [{ ...row, val: 88 }],
    } } } } })
  } })
  const app = await appFor(t, { sec })
  const search = await app.inject('/api/v1/disclosures/us?q=320193')
  assert.equal(search.json().companies[0].id, '0000320193')
  const response = await app.inject('/api/v1/disclosures/us?cik=320193')
  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.json().financials.map(item => [item.period, item.unit, item.start, item.end, item.value]), [
    ['quarter', 'USD', '2026-03-29', end, 217],
  ])
  assert.ok(starts[1] - starts[0] >= 249 && starts[2] - starts[1] >= 249)
  assert.ok(!response.body.includes(userAgent))
})
