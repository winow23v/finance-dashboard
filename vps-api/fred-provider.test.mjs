import assert from 'node:assert/strict'
import test from 'node:test'
import { randomBytes } from 'node:crypto'
import { Writable } from 'node:stream'
import { createFredProvider } from './fred-provider.mjs'
import { buildApp } from './server.mjs'

const endpoint = '/api/v1/economy/indicators'
const time = '2026-11-20T08:00:00.000Z'
const mockKey = randomBytes(16).toString('hex')
const privateAccessToken = randomBytes(32).toString('hex')
const privateHeaders = { authorization: 'Bearer ' + privateAccessToken, host: '127.0.0.1:3001' }

function requestPrivate(app) {
  return app.inject({ url: endpoint, headers: privateHeaders })
}
const fixtureRows = {
  DFEDTARU: [['2026-11-19', '4.00']],
  DGS10: [['2026-11-19', '.'], ['2026-11-10', '5.1']],
  CPIAUCSL: [['2026-10-01', '330'], ['2026-09-01', '320'], ['2025-11-01', '307'], ['2025-10-01', '300']],
  UNRATE: [['2026-10-01', '.'], ['2026-09-01', '4.1']],
}

function mockResponse(url, rows = fixtureRows) {
  const id = url.searchParams.get('series_id')
  assert.equal(url.origin, 'https://api.stlouisfed.org')
  assert.ok(url.searchParams.get('api_key') === mockKey, 'Incorrect FRED test credential')
  assert.equal(url.searchParams.get('file_type'), 'json')
  if (url.pathname === '/fred/series') return Response.json({
    seriess: [{
      id,
      frequency_short: id === 'CPIAUCSL' || id === 'UNRATE' ? 'M' : 'D',
      units: id === 'CPIAUCSL' ? 'Index 1982-1984=100' : 'Percent',
      last_updated: '2026-11-19 08:30:00-06',
    }],
  })
  assert.equal(url.pathname, '/fred/series/observations')
  assert.equal(url.searchParams.get('sort_order'), 'desc')
  assert.equal(url.searchParams.get('limit'), id === 'CPIAUCSL' ? '24' : '14')
  return Response.json({
    observations: rows[id].map(([date, value]) => ({ date, value, realtime_start: '2026-11-19' })),
  })
}

function key(t, value = mockKey) {
  const previous = process.env.FRED_API_KEY
  if (value) process.env.FRED_API_KEY = value
  else delete process.env.FRED_API_KEY
  t.after(() => {
    if (previous === undefined) delete process.env.FRED_API_KEY
    else process.env.FRED_API_KEY = previous
  })
}

async function appFor(t, getEconomyIndicators, logger = false) {
  const app = await buildApp({ getEconomyIndicators, privateAccessToken, logger })
  t.after(() => app.close())
  return app
}

test('normalizes four series and calculates CPI YoY from exactly the same month a year earlier', async t => {
  key(t)
  let calls = 0
  const provider = createFredProvider({
    now: () => new Date(time),
    fetchImpl: (url, options) => {
      calls++
      assert.equal(options.cache, 'no-store')
      assert.equal(options.redirect, 'error')
      return mockResponse(url)
    },
  })
  const app = await appFor(t, provider)
  const [one, two] = await Promise.all([provider(), provider()])
  assert.equal(one, two)
  assert.equal(calls, 8)
  const response = await requestPrivate(app)
  assert.equal(response.statusCode, 200)
  assert.equal(response.headers['cache-control'], 'no-store')
  assert.equal(response.headers['access-control-allow-origin'], undefined)
  assert.equal(calls, 16)
  const { source, indicators } = response.json()
  assert.deepEqual(source, { label: 'FRED', simulated: false })
  const [fed, treasury, cpi, cpiChange, unemployment] = indicators
  assert.equal(fed.value, 4)
  assert.equal(fed.stale, false)
  assert.match(fed.source.agency, /Board of Governors/)
  assert.deepEqual([treasury.value, treasury.observationDate, treasury.stale], [5.1, '2026-11-10', true])
  assert.deepEqual([cpi.unit, cpi.value], ['index', 330])
  assert.equal(cpi.source.agency, 'U.S. Bureau of Labor Statistics')
  assert.equal(cpiChange.unit, '%')
  assert.ok(Math.abs(cpiChange.value - 10) < 1e-10)
  assert.equal(cpiChange.observationDate, cpi.observationDate)
  assert.equal(cpiChange.comparisonPeriod, '2025-10-01')
  assert.equal(cpiChange.missingReason, null)
  assert.equal(unemployment.value, null)
  assert.equal(unemployment.observationDate, '2026-10-01')
  assert.equal(unemployment.stale, null)
  assert.deepEqual(indicators.map(row => [row.seriesId, row.unit, row.observationDate]), [
    ['DFEDTARU', '%', '2026-11-19'], ['DGS10', '%', '2026-11-10'],
    ['CPIAUCSL', 'index', '2026-10-01'], ['CPIAUCSL', '%', '2026-10-01'],
    ['UNRATE', '%', '2026-10-01'],
  ])
  assert.equal(treasury.source.agency, fed.source.agency)
  assert.equal(unemployment.source.agency, cpi.source.agency)
  for (const row of indicators) {
    assert.equal(row.releaseDate, null)
    assert.equal(row.collectedAt, time)
    assert.equal(row.source.url, 'https://fred.stlouisfed.org/series/' + row.seriesId)
  }
})

test('a missing exact CPI comparison and a daily series without numeric observations stay null', async t => {
  key(t)
  const rows = {
    ...fixtureRows,
    DFEDTARU: [['2026-11-19', '.']],
    CPIAUCSL: [['2026-10-01', '330'], ['2025-11-01', '300'], ['2025-10-01', '.']],
  }
  const { indicators } = await createFredProvider({ fetchImpl: url => mockResponse(url, rows) })()
  assert.equal(indicators[0].value, null)
  assert.equal(indicators[0].observationDate, null)
  assert.equal(indicators[2].value, 330)
  assert.equal(indicators[3].value, null)
  assert.equal(indicators[3].comparisonPeriod, '2025-10-01')
  assert.equal(indicators[3].missingReason, 'COMPARISON_MISSING')
})

test('CPI uses dates even when rows are sparse and out of order, and never fills the current month', async t => {
  key(t)
  const rows = { ...fixtureRows, CPIAUCSL: [
    ['2025-12-01', '300'], ['2026-11-01', '327'], ['2026-12-01', '324'], ['2025-11-01', '.'],
  ] }
  const provider = createFredProvider({ fetchImpl: url => mockResponse(url, rows) })
  const first = (await provider()).indicators[3]
  assert.equal(first.observationDate, '2026-12-01')
  assert.equal(first.comparisonPeriod, '2025-12-01')
  assert.equal(first.value, 8)
  rows.CPIAUCSL[2][1] = '.'
  const missing = (await provider()).indicators[3]
  assert.equal(missing.observationDate, '2026-12-01')
  assert.equal(missing.value, null)
  assert.equal(missing.missingReason, 'CURRENT_MISSING')
})

test('malformed provider observations, HTTP errors and oversized responses return sanitized 502/503', async t => {
  key(t)
  const responses = [
    [url => mockResponse(url, { ...fixtureRows, UNRATE: [['2026-02-30', '4.1']] }), 502],
    [url => mockResponse(url, { ...fixtureRows, UNRATE: [['2026-10-01', '']] }), 502],
    [() => new Response('api_key=' + mockKey, { status: 500 }), 502],
    [() => new Response('busy', { status: 429 }), 503],
    [() => new Response('x'.repeat(66_000)), 502],
    [url => { throw new Error(url.href) }, 502],
  ]
  let fetchImpl
  let logs = ''
  const stream = new Writable({ write(chunk, _encoding, done) { logs += chunk; done() } })
  const app = await appFor(t, createFredProvider({ fetchImpl: (...args) => fetchImpl(...args) }), { stream })
  for (const [response, status] of responses) {
    fetchImpl = response
    const result = await requestPrivate(app)
    assert.equal(result.statusCode, status)
    assert.ok(!result.body.includes(mockKey) && !result.body.includes(privateAccessToken) && !result.body.includes('api_key'), 'Credential leaked in response')
  }
  assert.ok(logs.includes('Request failed'))
  assert.ok(!logs.includes(mockKey) && !logs.includes(privateAccessToken) && !logs.includes('api_key'), 'Credential leaked in logs')
})

test('times out and aborts outstanding FRED requests', async t => {
  key(t)
  const signals = []
  const app = await appFor(t, createFredProvider({
    timeoutMs: 20,
    fetchImpl: (_url, { signal }) => {
      signals.push(signal)
      return new Promise(() => {})
    },
  }))
  assert.equal((await requestPrivate(app)).statusCode, 503)
  assert.equal(signals.length, 8)
  assert.ok(signals.every(signal => signal.aborted))
  assert.equal((await requestPrivate(app)).statusCode, 503)
  assert.equal(signals.length, 8)
})

test('FRED has a shared rolling quota independent of caller IP and recovers after the window', async t => {
  key(t)
  let time = 0
  let calls = 0
  const provider = createFredProvider({
    clock: () => time,
    maxBatchesPerMinute: 1,
    fetchImpl: url => { calls++; return mockResponse(url) },
  })
  await Promise.all([provider(), provider()])
  time = 59_999
  assert.throws(provider, { statusCode: 503 })
  assert.equal(calls, 8)
  time++
  await provider()
  assert.equal(calls, 16)
})

test('private data requires a real loopback peer and a separate access credential', async t => {
  let calls = 0
  const app = await appFor(t, () => { calls++; return { source: { label: 'FRED', simulated: false } } })
  for (const options of [
    { remoteAddress: '203.0.113.5', headers: privateHeaders },
    { remoteAddress: '203.0.113.5', headers: { host: '127.0.0.1:3001', 'x-forwarded-for': '127.0.0.1', 'x-real-ip': '127.0.0.1' } },
    { remoteAddress: '127.0.0.1' },
    { remoteAddress: '127.0.0.1', headers: { ...privateHeaders, host: 'winow.duckdns.org' } },
    { remoteAddress: '127.0.0.1', headers: { host: '127.0.0.1:3001', authorization: 'Bearer ' + '0'.repeat(64) } },
    ...['x-forwarded-for', 'x-forwarded-host', 'x-real-ip', 'forwarded'].map(header =>
      ({ remoteAddress: '127.0.0.1', headers: { ...privateHeaders, [header]: '127.0.0.1' } })),
  ]) {
    const denied = await app.inject({ url: endpoint, ...options })
    assert.equal(denied.statusCode, 404)
    assert.equal(denied.headers['cache-control'], 'no-store')
  }
  assert.equal(calls, 0)
  const direct = await requestPrivate(app)
  assert.equal(direct.statusCode, 200)
  assert.equal(calls, 1)
  assert.equal((await app.inject('/api/v1/admin')).statusCode, 404)
})

test('disabled and missing-key routes make no calls and share the existing market quota', async t => {
  key(t, '')
  const disabled = await appFor(t)
  const response = await requestPrivate(disabled)
  assert.equal(response.statusCode, 503)
  assert.equal(response.json().code, 'FRED_DISABLED')
  assert.equal((await disabled.inject(endpoint + '?series=UNRATE')).statusCode, 400)
  assert.equal((await disabled.inject({ url: endpoint, method: 'HEAD' })).statusCode, 404)
  const app = await appFor(t, createFredProvider({ fetchImpl: () => assert.fail('Missing key') }))
  assert.equal((await requestPrivate(app)).statusCode, 503)
  for (let i = 0; i < 59; i++) {
    assert.equal((await app.inject('/api/v1/market/snapshot')).statusCode, 200)
  }
  const limited = await requestPrivate(app)
  assert.equal(limited.statusCode, 429)
  assert.ok(Number(limited.headers['retry-after']) > 0)
  assert.equal((await app.inject('/health')).statusCode, 200)
})

test('private mode refuses to start without a well-formed access credential', async () => {
  await assert.rejects(buildApp({ getEconomyIndicators: () => {}, logger: false }), /missing or invalid/)
})
