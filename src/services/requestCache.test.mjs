import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequestCache } from './requestCache.ts'

test('analytics is opt-in and events redact ticker, account paths and search text', async () => {
  const { analyticsId, createAnalytics } = await import('./analytics.ts')
  assert.equal(analyticsId('', ''), undefined)
  assert.equal(analyticsId('1', 'invalid'), undefined)
  const events = []
  const tracker = createAnalytics({ measurementId: 'fixture', origin: 'https://example.test', base: '/finance/',
    command: (...args) => events.push(args) })
  tracker.configure()
  tracker.page('stock/XKRX/005930')
  tracker.page('stock/XKRX/005930')
  tracker.page('search/secret-query')
  tracker.page('domestic')
  assert.equal(events.filter(args => args[0] === 'event' && args[1] === 'page_view').length, 3)
  assert.equal(events.filter(args => args[1] === 'market_view').length, 1)
  assert.ok(events.some(args => args[1] === 'stock_detail_view'))
  assert.doesNotMatch(JSON.stringify(events), /005930|secret-query|XKRX/)
})

test('analytics consent responds to removal in a separate tab', async t => {
  const { subscribeAnalyticsConsent } = await import('./analytics.ts')
  const states = []
  const tab = new EventTarget()
  const unsubscribe = subscribeAnalyticsConsent(granted => states.push(granted), tab)
  t.after(unsubscribe)
  const storage = key => Object.assign(new Event('storage'), { key })
  tab.dispatchEvent(storage('unrelated'))
  tab.dispatchEvent(storage('finance.analytics-consent.v1'))
  tab.dispatchEvent(storage(null))
  unsubscribe()
  tab.dispatchEvent(storage('finance.analytics-consent.v1'))
  assert.deepEqual(states, [false, false])
})

test('browser cache shares concurrent requests, expires entries, and bounds retained responses', async () => {
  let now = 0
  let calls = 0
  const cache = createRequestCache(2, 10, () => now)
  const load = async () => ++calls
  assert.deepEqual(await Promise.all([cache.load('a', load), cache.load('a', load)]), [1, 1])
  assert.equal(await cache.load('a', load), 1)
  now = 10
  assert.equal(cache.read('a'), undefined)
  assert.equal(await cache.load('a', load), 2)
  await cache.load('b', load)
  await cache.load('c', load)
  assert.equal(cache.read('a'), undefined)
  assert.equal(cache.read('b'), 3)
})

test('a failed request can be retried without retaining the failure', async () => {
  const cache = createRequestCache(2, 100)
  await assert.rejects(cache.load('a', async () => { throw new Error('unavailable') }), /unavailable/)
  assert.equal(await cache.load('a', async () => 1), 1)
})

test('watchlist ordering preserves storage order and sorts missing numeric values last', async () => {
  const { rankWatchlist } = await import('./watchlistView.ts')
  const rows = [{ name: '종목 10', change: null }, { name: '종목 2', change: -4 }, { name: '종목 1', change: 3 }]
  const sort = order => rankWatchlist(rows, order, row => row.name, row => row.change).map(row => row.name)
  assert.deepEqual(sort('saved'), ['종목 10', '종목 2', '종목 1'])
  assert.deepEqual(sort('name'), ['종목 1', '종목 2', '종목 10'])
  assert.deepEqual(sort('change'), ['종목 1', '종목 2', '종목 10'])
  assert.deepEqual(rankWatchlist(rows, 'price', row => row.name, row => row.name === '종목 2' ? 200 : row.name === '종목 1' ? 100 : null).map(row => row.name),
    ['종목 2', '종목 1', '종목 10'])
  assert.equal(rows[0].name, '종목 10')
})


test('a non-cacheable result is retried and an invalidated request cannot replace newer data', async () => {
  const cache = createRequestCache(2, 1000)
  assert.equal(await cache.load('a', async () => 0, value => value > 0), 0)
  assert.equal(cache.read('a'), undefined)
  let resolve
  const old = cache.load('a', () => new Promise(finish => { resolve = finish }))
  await Promise.resolve()
  cache.invalidate('a')
  assert.equal(await cache.load('a', async () => 2), 2)
  resolve(1)
  assert.equal(await old, 1)
  assert.equal(cache.read('a'), 2)
})
