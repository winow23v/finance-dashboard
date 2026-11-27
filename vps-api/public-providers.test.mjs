import assert from 'node:assert/strict'
import { test } from 'node:test'
import { zipSync, strToU8 } from 'fflate'
import { buildApp } from './server.mjs'
import { createDartProvider } from './dart-provider.mjs'
import { createEcosProvider } from './ecos-provider.mjs'
import { createFxProvider } from './fx-provider.mjs'

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
      assert.equal(query.get('quotes'), 'USD,KRW,JPY,CNY,GBP,CHF,AUD,CAD')
      assert.equal(query.get('from'), '2025-04-05')
      return Response.json([
        fxRow(date, 'JPY', 160), fxRow(date, 'USD', 1.25), fxRow(date, 'KRW', 1500),
        fxRow(date, 'GBP', 0.8), fxRow(date, 'CNY', 8), fxRow(date, 'CHF', 0.9),
        fxRow(date, 'AUD', 1.6), fxRow(date, 'CAD', 1.5), fxRow('2026-03-31', 'GBP', 0.75),
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
  const { reference } = latest.json()
  assert.equal(reference.observationDate, date)
  assert.equal(reference.rates.JPY.KRW, 1500 / 160)
  assert.equal(reference.rates.GBP.CAD, 1.5 / 0.8)
  assert.equal(reference.rates.CNY.CHF, 0.9 / 8)
  const alternate = await app.inject('/api/v1/fx/history?base=GBP&quote=KRW')
  assert.equal(alternate.statusCode, 200)
  assert.deepEqual(alternate.json().points, [{ observationDate: date, rate: 1500 / 0.8 }])
  for (const [period, count] of [['1M', 2], ['3M', 3], ['1Y', 3]]) {
    const result = await app.inject(`/api/v1/fx/history?base=USD&quote=KRW&period=${period}`)
    assert.equal(result.json().points.length, count)
  }
  for (const path of [
    '/api/v1/fx/history?base=KRW&quote=KRW',
    '/api/v1/fx/history?base=XXX&quote=KRW',
    '/api/v1/fx/history?base=USD&quote=KRW&period=1D',
    '/api/v1/fx/latest?key=anything',
  ]) assert.equal((await app.inject(path)).statusCode, 400)
  assert.equal(calls, 1)
})

test('Frankfurter errors and schema changes produce sanitized provider statuses', async t => {
  for (const [response, status, code] of [
    [Response.json({}, { status: 429 }), 503, 'PROVIDER_RATE_LIMITED'],
    [Response.json({}, { status: 500 }), 502, 'PROVIDER_UNAVAILABLE'],
    [new Response('{'), 502, 'PROVIDER_INVALID_JSON'],
    [new Response('x'.repeat(384 * 1024 + 1)), 502, 'PROVIDER_RESPONSE_TOO_LARGE'],
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

test('Frankfurter timeout, connection, and body failures differ and cold failures are throttled', async t => {
  for (const [fetchImpl, status, code] of [
    [async () => { throw new Error('private upstream error') }, 502, 'PROVIDER_CONNECTION_ERROR'],
    [async () => new Response(new ReadableStream({
      pull(controller) {
        controller.error(new TypeError('private upstream error', { cause: { code: 'UND_ERR_SOCKET' } }))
      },
    })), 502, 'PROVIDER_BODY_ERROR'],
    [async (_url, { signal }) => {
      await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    }, 504, 'PROVIDER_TIMEOUT'],
  ]) {
    let calls = 0
    const fx = createFxProvider({ timeoutMs: 20, fetchImpl: (...args) => { calls++; return fetchImpl(...args) } })
    const app = await appFor(t, { fx })
    const latest = await app.inject('/api/v1/fx/latest')
    const history = await app.inject('/api/v1/fx/history?base=JPY&quote=KRW&period=1Y')
    for (const result of [latest, history]) {
      assert.equal(result.statusCode, status)
      assert.equal(result.json().code, code)
      assert.ok(!result.body.includes('private upstream error'))
    }
    assert.equal(calls, code === 'PROVIDER_CONNECTION_ERROR' ? 1 : 2)
  }
})

test('provider configuration and query errors are distinct and never call upstream', async t => {
  const fail = () => assert.fail('Unexpected upstream request')
  const app = await appFor(t, {
    ecos: createEcosProvider({ key: '', fetchImpl: fail }),
    dart: createDartProvider({ key: '', fetchImpl: fail }),
  })
  for (const [path, code] of [
    ['/api/v1/economy/korea', 'ECOS_CONFIGURATION_MISSING'],
    ['/api/v1/disclosures/kr?q=005930', 'DART_CONFIGURATION_MISSING'],
  ]) {
    const result = await app.inject(path)
    assert.equal(result.statusCode, 503)
    assert.equal(result.json().code, code)
  }
  for (const path of [
    '/api/v1/economy/korea?key=abc',
    '/api/v1/disclosures/kr?corpCode=00126380&year=2025',
    '/api/v1/disclosures/kr?q=삼성&period=q1',
    '/api/v1/disclosures/kr?q=삼성&page=0',
    '/api/v1/disclosures/kr?corpCode=00126380&page=2',
  ]) assert.equal((await app.inject(encodeURI(path))).statusCode, 400)
})

test('ECOS validates the official series and preserves collection, observation, and release dates', async t => {
  const key = 'test-ecos-key'
  let now = Date.parse('2026-04-05T12:00:00Z')
  let calls = 0
  let exactComparison = true
  const ecos = createEcosProvider({ key, clock: () => now, fetchImpl: async url => {
    calls++
    if (url.includes('/901Y009/')) {
      assert.match(url, /\/1\/24\/901Y009\/M\/202405\/202604\/0$/)
      return Response.json({ StatisticSearch: { row: [
        { STAT_CODE: '901Y009', ITEM_CODE1: '0', TIME: exactComparison ? '202503' : '202502', UNIT_NAME: '2020=100', DATA_VALUE: '118' },
        { STAT_CODE: '901Y009', ITEM_CODE1: '0', TIME: '202603', UNIT_NAME: '2020=100', DATA_VALUE: '120.5' },
      ] } })
    }
    if (url.includes('/901Y027/')) {
      assert.match(url, /I61BC\/I28A$/)
      return Response.json({ StatisticSearch: { row: [
        { STAT_CODE: '901Y027', ITEM_CODE1: 'I61BC', ITEM_CODE2: 'I28A', TIME: '202603', UNIT_NAME: '%', DATA_VALUE: '3.1' },
      ] } })
    }
    assert.match(url, /\/722Y001\/D\/20260106\/20260405\/0101000$/)
    return Response.json({ StatisticSearch: { row: [
      { STAT_CODE: '722Y001', ITEM_CODE1: '0101000', TIME: '20260403', UNIT_NAME: '연%', DATA_VALUE: '2.5' },
    ] } })
  } })
  const app = await appFor(t, { ecos })
  const request = () => app.inject('/api/v1/economy/korea')
  const [result, concurrent] = await Promise.all([request(), request()])
  assert.equal(result.statusCode, 200)
  assert.equal(concurrent.body, result.body)
  assert.equal(calls, 3)
  const [rate, cpi, unemployment] = result.json().indicators
  assert.equal(rate.value, 2.5)
  assert.equal(rate.observationDate, '2026-04-03')
  assert.equal(rate.releaseDate, null)
  assert.equal(rate.collectedAt, '2026-04-05T12:00:00.000Z')
  assert.deepEqual([cpi.value, unemployment.value], [120.5, 3.1])
  assert.equal(cpi.observationDate, null)
  assert.equal(cpi.observationPeriod, '2026-03')
  assert.deepEqual(cpi.history, [{ period: '2025-03', value: 118 }, { period: '2026-03', value: 120.5 }])
  assert.deepEqual(rate.history, [{ period: '2026-04-03', value: 2.5 }])
  assert.deepEqual(unemployment.history, [{ period: '2026-03', value: 3.1 }])
  assert.equal(cpi.yearOverYear.comparisonPeriod, '2025-03')
  assert.ok(Math.abs(cpi.yearOverYear.value - (120.5 - 118) / 118 * 100) < 1e-10)
  assert.equal(unemployment.agency.name, '국가데이터처 KOSIS')
  assert.ok(!result.body.includes(key))
  now += 5 * 60_000 - 1
  assert.equal((await request()).body, result.body)
  assert.equal(calls, 3)
  now++
  exactComparison = false
  const refreshed = await request()
  assert.equal(refreshed.statusCode, 200)
  assert.equal(refreshed.json().indicators[1].yearOverYear, undefined)
  assert.equal(calls, 6)
})

test('each provider sanitizes supplier errors and secret-bearing messages', async t => {
  const key = 'test-sentinel-key'
  const app = await appFor(t, {
    ecos: createEcosProvider({ key, fetchImpl: async () => Response.json({ RESULT: { CODE: 'ERROR-100', MESSAGE: key } }) }),
    dart: createDartProvider({ key, fetchImpl: async () => new Response(`<?xml version="1.0"?><result><status>010</status><message>${key}</message></result>`) }),
  })
  for (const [path, code] of [
    ['/api/v1/economy/korea', 'ECOS_PROVIDER_ERROR'],
    ['/api/v1/disclosures/kr?q=005930', 'DART_PROVIDER_ERROR'],
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
  let filingCalls = 0
  const otherCompanies = Array.from({ length: 24 }, (_, i) =>
    `<list><corp_code>${String(20_000_000 + i)}</corp_code><corp_name>삼성 테스트 ${i}</corp_name><stock_code>${100_000 + i}</stock_code></list>`,
  )
  const archive = zipSync({ 'CORPCODE.xml': strToU8(`<?xml version="1.0"?><result>
    <list><corp_code>${corp}</corp_code><corp_name>삼성전자</corp_name><stock_code>${ticker}</stock_code></list>
    <list><corp_code>00123456</corp_code><corp_name>비상장</corp_name><stock_code> </stock_code></list>
    ${otherCompanies.join('')}</result>`) })
  const fetchImpl = async rawUrl => {
    const url = new URL(rawUrl)
    assert.equal(url.searchParams.get('crtfc_key'), key)
    if (url.pathname.endsWith('corpCode.xml')) {
      catalogCalls++
      return new Response(archive)
    }
    assert.equal(url.searchParams.get('corp_code'), corp)
    if (url.pathname.endsWith('list.json')) {
      filingCalls++
      assert.equal(url.searchParams.get('last_reprt_at'), 'N')
      assert.equal(url.searchParams.get('sort'), 'date')
      assert.equal(url.searchParams.get('sort_mth'), 'desc')
      const amendment = { corp_code: corp, rcept_dt: '20260401', rcept_no: id, report_nm: '[기재정정]분기보고서' }
      return Response.json({ status: '000', list: [amendment, amendment, { ...amendment, rcept_no: '20260331000001', report_nm: '분기보고서' }] })
    }
    if (url.searchParams.get('reprt_code') === '11011') return new Response(null, { status: 502 })
    assert.equal(url.searchParams.get('reprt_code'), '11013')
    assert.equal(url.searchParams.get('bsns_year'), '2025')
    const row = { stock_code: ticker, bsns_year: '2025', reprt_code: '11013',
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
  const query = '/api/v1/disclosures/kr?q=' + encodeURIComponent('삼성')
  const legacy = (await app.inject(query)).json()
  assert.equal(legacy.total, 25)
  assert.equal(legacy.companies.length, 20)
  const first = (await app.inject(query + '&page=1')).json()
  const last = (await app.inject(query + '&page=3')).json()
  assert.deepEqual(first.companies, legacy.companies.slice(0, 10))
  assert.equal(last.total, 25)
  assert.equal(last.companies.length, 5)
  assert.ok(last.companies.every(company => !legacy.companies.some(item => item.id === company.id)))
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
  assert.equal(filingCalls, 1)
})

test('Frankfurter 2,040-row weekend response is shared across UTC midnight and all history periods', async t => {
  const lastDay = Date.parse('2026-11-20T00:00:00Z')
  const quotes = { AUD: 1.6, CAD: 1.5, CHF: 0.9, CNY: 8, GBP: 0.8, JPY: 160, KRW: 1500, USD: 1.25 }
  const published = []
  for (let time = lastDay; time >= Date.parse('2025-11-22') && published.length < 254; time -= 86_400_000) {
    const cursor = new Date(time)
    if (![0, 6].includes(cursor.getUTCDay())) {
      published.push(cursor.toISOString().slice(0, 10))
    }
  }
  const rows = ['2025-11-21', ...published].flatMap(day =>
    Object.entries(quotes).map(([quote, rate]) => fxRow(day, quote, rate)))
  const raw = JSON.stringify(rows)
  assert.equal(rows.length, 2040)
  assert.ok(Buffer.byteLength(raw) > 120_000 && Buffer.byteLength(raw) < 384 * 1024)
  let now = Date.parse('2026-11-22T23:59:59Z')
  let calls = 0
  let started
  let finish
  const firstRequest = new Promise(resolve => { started = resolve })
  const response = new Promise(resolve => { finish = resolve })
  const fx = createFxProvider({ clock: () => now, fetchImpl: async url => {
    calls++
    if (calls === 1) {
      assert.equal(new URL(url).searchParams.get('from'), '2025-11-22')
      started()
      return response
    }
    return new Response(JSON.stringify(rows.filter(row => row.date > '2025-11-21')))
  } })
  const app = await appFor(t, { fx })
  const latest = app.inject('/api/v1/fx/latest')
  await firstRequest
  now += 2000
  // Invoke history while the first response is pending under the previous UTC date.
  const histories = ['1W', '1M', '3M', '1Y'].map(period => fx.history('JPY/KRW', period))
  finish(new Response(raw))
  const rate = (await latest).json()
  assert.equal(rate.reference.observationDate, '2026-11-20')
  assert.equal(rate.reference.rates.USD.KRW, 1200)
  assert.equal(rate.reference.rates.EUR.KRW, 1500)
  assert.equal(rate.reference.rates.JPY.KRW, 1500 / 160)
  const results = await Promise.all(histories)
  for (const result of results) {
    assert.equal(result.points.at(-1).observationDate, '2026-11-20')
    assert.equal(result.points.at(-1).rate, 1500 / 160)
    assert.ok(result.points.every(point => point.observationDate >= result.from))
  }
  assert.deepEqual(results.map(item => item.points.length), [4, 21, 65, 254])
  assert.equal(calls, 1)
  assert.equal((await app.inject('/api/v1/fx/history?base=JPY&quote=KRW&period=1Y')).statusCode, 200)
  assert.equal((await app.inject('/api/v1/fx/latest')).statusCode, 200)
  assert.equal(calls, 2)
})

test('failed refresh preserves the last publication for both routes and defers retry', async t => {
  let now = Date.parse('2026-11-20T18:00:00Z')
  let calls = 0
  const initial = ['USD', 'JPY', 'KRW'].map((quote, index) => fxRow('2026-11-20', quote, [1.25, 160, 1500][index]))
  const fx = createFxProvider({ clock: () => now, fetchImpl: async () => {
    calls++
    if (calls === 2) return Response.json([...initial, initial[0]])
    if (calls === 3) return Response.json({}, { status: 502 })
    return Response.json(initial)
  } })
  const app = await appFor(t, { fx })
  const old = (await app.inject('/api/v1/fx/latest')).json()
  assert.equal(old.reference.status, 'published_today')
  now += 16 * 60_000
  const [latest, history] = await Promise.all([
    app.inject('/api/v1/fx/latest'),
    app.inject('/api/v1/fx/history?base=JPY&quote=KRW&period=1W'),
  ])
  assert.equal(latest.statusCode, 200)
  assert.equal(history.statusCode, 200)
  for (const result of [latest.json(), history.json()]) {
    assert.equal(result.refreshError, 'INVALID_PROVIDER_RESPONSE')
    assert.equal((result.reference ?? result).status, 'previous_publication')
    assert.equal((result.reference ?? result).collectedAt, old.reference.collectedAt)
  }
  assert.deepEqual(latest.json().reference.rates, old.reference.rates)
  assert.equal(history.json().points.at(-1).rate, 1500 / 160)
  await fx.latest()
  assert.equal(calls, 2)
  now += 60_000
  const unavailable = await fx.latest()
  assert.equal(unavailable.refreshError, 'PROVIDER_UNAVAILABLE')
  assert.equal(unavailable.reference.collectedAt, old.reference.collectedAt)
  assert.equal(calls, 3)
  now += 60_000
  const recovered = await fx.latest()
  assert.equal(recovered.refreshError, undefined)
  assert.equal(recovered.reference.status, 'published_today')
  assert.equal(calls, 4)
})

test('Frankfurter retries a transient transport failure once and shares the successful publication', async () => {
  const date = '2026-11-25'
  let calls = 0
  const fx = createFxProvider({ clock: () => Date.parse(date), async fetchImpl() {
    if (++calls === 1) throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } })
    return Response.json([fxRow(date, 'USD', 1.2), fxRow(date, 'KRW', 1440), fxRow(date, 'JPY', 160)])
  } })
  const [latest, history] = await Promise.all([fx.latest(), fx.history('JPY/KRW', '1W')])
  assert.equal(calls, 2)
  assert.equal(latest.reference.observationDate, date)
  assert.equal(latest.reference.rates.USD.KRW, 1200)
  assert.deepEqual(history.points, [{ observationDate: date, rate: 9 }])
})
