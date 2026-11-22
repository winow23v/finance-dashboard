import assert from 'node:assert/strict'
import test from 'node:test'
import { buildApp } from './server.mjs'
import { createMarketCache } from './market-cache.mjs'
import { createIndexSnapshot } from './market-index-provider.mjs'

const snapshot = '/api/v1/market/snapshot'
const history = '/api/v1/market/history'
const asOf = '2026-11-18T21:00:00Z'

async function fixture(t, options) {
  const app = await buildApp({ logger: false, ...options })
  t.after(() => app.close())
  return app
}

test('market routes report absent providers without simulated observations', async t => {
  const app = await fixture(t, { cache: createMarketCache({ wallClock: () => Date.parse(asOf) + 172_800_000 }) })
  const health = await app.inject('/health')
  assert.equal(health.statusCode, 200)
  assert.deepEqual(health.json(), { status: 'ok' })
  const market = await app.inject(snapshot)
  assert.equal(market.statusCode, 200)
  assert.equal(market.headers['access-control-allow-origin'], undefined)
  assert.equal(market.headers['cache-control'], 'no-store')
  assert.equal(market.headers['x-content-type-options'], 'nosniff')
  assert.equal(market.json().source.simulated, false)
  assert.equal(market.json().updatedAt, null)
  assert.equal(market.headers['x-market-as-of'], undefined)
  assert.equal(market.json().quotes.length, 5)
  assert.ok(market.json().quotes.every(quote => quote.price === null && quote.status === 'unavailable'))
  const series = await app.inject(`${history}?symbolId=kospi`)
  assert.equal(series.statusCode, 200)
  assert.deepEqual(series.json(), [])
})

test('research close is available on loopback only and never enters the shared snapshot cache', async t => {
  const app = await fixture(t, { localIndexResearch: createIndexSnapshot({
    async getQuote(symbol) {
      if (symbol === '^IXIC') return { dataStatus: 'no-observation' }
      return { symbol, close: 5050, previousClose: 5000, dataStatus: 'stale',
        distribution: 'local-research-only', observedAt: asOf, collectedAt: asOf, tradingDate: '2026-11-18' }
    },
  }) })
  const local = { url: snapshot, remoteAddress: '127.0.0.1', headers: { host: '127.0.0.1:5174' } }
  const response = await app.inject(local)
  const quotes = response.json().quotes
  assert.equal(quotes[2].price, 5050)
  assert.equal(quotes[2].change, 50)
  assert.equal(quotes[2].changePercent, 1)
  assert.equal(quotes[2].status, 'stale')
  assert.equal(quotes[3].reason, 'no-observation')
  for (const request of [
    { ...local, headers: { host: 'api.example' } },
    { ...local, headers: { ...local.headers, 'x-forwarded-for': '192.0.2.1' } },
    { ...local, remoteAddress: '192.0.2.1' },
  ]) {
    assert.ok((await app.inject(request)).json().quotes.every(quote => quote.price === null))
  }
})

test('rejects malformed inputs and preserves the missing-index response', async t => {
  const app = await fixture(t)
  for (const query of ['', '?symbolId=', '?symbolId=kospi&period=bad', '?symbolId=kospi&extra=1',
    '?symbolId=kospi&symbolId=spx', '?symbolId=' + 'a'.repeat(33), '?symbolId=%20']) {
    assert.equal((await app.inject(history + query)).statusCode, 400, query)
  }
  const missing = await app.inject(`${history}?symbolId=unknown`)
  assert.equal(missing.statusCode, 404)
  assert.deepEqual(missing.json(), { error: 'Index not found' })
})

test('shares the market IP quota, isolates health, and ignores untrusted forwarding', async t => {
  const app = await fixture(t)
  const viaProxy = (url, forwarded, method = 'GET') => app.inject({
    url, method, remoteAddress: '127.0.0.1', headers: { 'x-forwarded-for': forwarded },
  })
  for (let i = 0; i < 60; i++) {
    assert.equal((await viaProxy(i % 2 ? snapshot : `${history}?symbolId=kospi`,
      `198.51.100.${i + 1}, 203.0.113.5`)).statusCode, 200)
  }
  const limited = await viaProxy(snapshot, '198.51.100.80, 203.0.113.5')
  assert.equal(limited.statusCode, 429)
  assert.ok(Number(limited.headers['retry-after']) > 0)
  assert.equal(limited.headers['cache-control'], 'no-store')
  assert.equal((await viaProxy(snapshot, '203.0.113.6')).statusCode, 200)
  for (let i = 0; i < 120; i++) {
    assert.equal((await viaProxy('/health', '203.0.113.5', i % 2 ? 'HEAD' : 'GET')).statusCode, 200)
  }
  assert.equal((await viaProxy('/health', '203.0.113.5')).statusCode, 429)
  assert.equal((await app.inject({
    url: snapshot, remoteAddress: '203.0.113.5', headers: { 'x-forwarded-for': '203.0.113.6' },
  })).statusCode, 429)
})

test('coalesces route requests, expires per TTL, and preserves market time after refresh', async t => {
  let now = 0
  let calls = 0
  let finish
  const wait = new Promise(resolve => { finish = resolve })
  const app = await fixture(t, {
    cache: createMarketCache({ clock: () => now, wallClock: () => Date.parse(asOf) + now }),
    provider: { snapshot: async () => { calls++; await wait; return { data: { ok: true }, asOf } } },
  })
  const requests = Promise.all(Array.from({ length: 10 }, () => app.inject(snapshot)))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls, 1)
  finish()
  const responses = await requests
  assert.ok(responses.every(response => response.statusCode === 200))
  now = 29_999
  assert.equal((await app.inject(snapshot)).headers['x-cache-stored-at'], responses[0].headers['x-cache-stored-at'])
  now = 30_000
  const refreshed = await app.inject(snapshot)
  assert.equal(calls, 2)
  assert.equal(refreshed.headers['x-market-as-of'], responses[0].headers['x-market-as-of'])
  assert.notEqual(refreshed.headers['x-cache-stored-at'], responses[0].headers['x-cache-stored-at'])
  assert.equal(refreshed.headers['x-market-stale'], 'false')
})

test('bounds cached bytes and entry count and rejects oversized responses', async () => {
  const policy = { ttlMs: 1000, staleAfterMs: 1000 }
  for (const limits of [{ maxEntries: 1 }, { maxBytes: 10 }]) {
    let calls = 0
    const cache = createMarketCache({ ...limits, maxResponseBytes: 10 })
    const load = async () => { calls++; return { data: '1234', asOf } }
    for (const key of ['a', 'b', 'a']) await cache.get(key, policy, load)
    assert.equal(calls, 3)
    await assert.rejects(cache.get('big', policy, () => ({ data: '1234567890', asOf })), { statusCode: 502 })
  }
})

test('provider failures are sanitized and timeout aborts work', async t => {
  let calls = 0
  let signal
  const app = await fixture(t, {
    cache: createMarketCache({ timeoutMs: 20 }),
    provider: {
      snapshot: abortSignal => {
        if (++calls === 1) throw new Error('private-provider-token')
        signal = abortSignal
        return new Promise(() => {})
      },
    },
  })
  const failed = await app.inject(snapshot)
  assert.equal(failed.statusCode, 502)
  assert.doesNotMatch(failed.body, /private-provider-token/)
  assert.equal((await app.inject(snapshot)).statusCode, 503)
  assert.equal(signal.aborted, true)
})

test('limits distinct provider calls while allowing requests to share pending work', async () => {
  const policy = { ttlMs: 1000, staleAfterMs: 1000 }
  const cache = createMarketCache({ maxPending: 1 })
  let finish
  const wait = new Promise(resolve => { finish = resolve })
  const first = cache.get('a', policy, () => wait)
  const shared = cache.get('a', policy, () => assert.fail('duplicate provider call'))
  await assert.rejects(cache.get('b', policy, () => assert.fail('provider capacity exceeded')), {
    statusCode: 503,
  })
  finish({ data: [1], asOf })
  const [one, two] = await Promise.all([first, shared])
  assert.equal(one.body, two.body)
  assert.equal((await cache.get('b', policy, () => ({ data: [2], asOf }))).body.toString(), '[2]')
})
