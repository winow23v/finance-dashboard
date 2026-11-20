import assert from 'node:assert/strict'
import test from 'node:test'
import { createFredProvider } from './fred-provider.mjs'
import { buildApp } from './server.mjs'

const endpoint = '/api/v1/economy/indicators'
const time = '2026-11-20T08:00:00.000Z'
const mockKey = 'synthetic-key-never-log'
const fixtureRows = {
  DFEDTARU: [['2026-11-19', '4.00']],
  DGS10: [['2026-11-19', '.'], ['2026-11-10', '5.1']],
  CPIAUCSL: [['2026-10-01', '330'], ['2026-09-01', '320'], ['2025-11-01', '307'], ['2025-10-01', '300']],
  UNRATE: [['2026-10-01', '.'], ['2026-09-01', '4.1']],
}

function mockResponse(url, rows = fixtureRows) {
  const id = url.searchParams.get('series_id')
  assert.equal(url.origin, 'https://api.stlouisfed.org')
  assert.equal(url.searchParams.get('api_key'), mockKey)
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

async function appFor(t, getEconomyIndicators) {
  const app = await buildApp({ getEconomyIndicators, logger: false })
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
  const response = await app.inject(endpoint)
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
  assert.equal(unemployment.value, null)
  assert.equal(unemployment.observationDate, '2026-10-01')
  assert.equal(unemployment.stale, null)
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
  const app = await appFor(t, createFredProvider({ fetchImpl: (...args) => fetchImpl(...args) }))
  for (const [response, status] of responses) {
    fetchImpl = response
    const result = await app.inject(endpoint)
    assert.equal(result.statusCode, status)
    assert.doesNotMatch(result.body, /synthetic-key|api_key/)
  }
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
  assert.equal((await app.inject(endpoint)).statusCode, 503)
  assert.equal(signals.length, 8)
  assert.ok(signals.every(signal => signal.aborted))
})

test('disabled and missing-key routes make no calls and share the existing market quota', async t => {
  key(t, '')
  const disabled = await appFor(t)
  const response = await disabled.inject(endpoint)
  assert.equal(response.statusCode, 503)
  assert.equal(response.json().code, 'FRED_DISABLED')
  assert.equal((await disabled.inject(endpoint + '?series=UNRATE')).statusCode, 400)
  assert.equal((await disabled.inject({ url: endpoint, method: 'HEAD' })).statusCode, 404)
  const app = await appFor(t, createFredProvider({ fetchImpl: () => assert.fail('Missing key') }))
  assert.equal((await app.inject(endpoint)).statusCode, 503)
  for (let i = 0; i < 59; i++) {
    assert.equal((await app.inject('/api/v1/market/snapshot')).statusCode, 200)
  }
  const limited = await app.inject(endpoint)
  assert.equal(limited.statusCode, 429)
  assert.ok(Number(limited.headers['retry-after']) > 0)
  assert.equal((await app.inject('/health')).statusCode, 200)
})
