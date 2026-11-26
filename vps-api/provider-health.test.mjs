import assert from 'node:assert/strict'
import test from 'node:test'
import { createProviderHealth } from './health-provider.mjs'
import { ProviderError, withHealthMetadata } from './public-provider.mjs'
import { buildApp } from './server.mjs'

test('provider monitoring suppresses scheduled waiting, redacts errors and deduplicates alert/recovery events', async () => {
  let now = Date.parse('2026-11-26')
  const health = createProviderHealth({ clock: () => now, alertDelayMs: 1_000 })
  await health.observe('yfinance', () => ({ status: 'unavailable', reason: 'collecting' }))
  assert.equal(health.snapshot().providers.find(row => row.provider === 'yfinance').status, 'Not Yet Collected')
  await health.observe('yfinance', () => ({ status: 'stale', reason: 'not-published' }))
  assert.equal(health.snapshot().providers.find(row => row.provider === 'yfinance').status, 'Stale')
  const fail = () => health.observe('fx', () => { throw new ProviderError(504, 'PROVIDER_TIMEOUT') })
  await assert.rejects(fail())
  now += 2_000
  await assert.rejects(fail())
  await assert.rejects(fail())
  assert.deepEqual(health.snapshot().alerts.events.map(event => event.kind), ['incident'])
  await health.observe('fx', () => ({ reference: { observationDate: '2026-11-25', collectedAt: new Date(now).toISOString() } }))
  assert.deepEqual(health.snapshot().alerts.events.map(event => event.kind), ['incident', 'recovery'])
  assert.equal(health.snapshot().providers.find(row => row.provider === 'fx').observationDate, '2026-11-25')
  await assert.rejects(health.observe('fx', () => { throw new Error('private path and token') }))
  assert.ok(!JSON.stringify(health.snapshot()).includes('private'))
})

test('operational health endpoint requires approved administrator', async t => {
  const app = await buildApp({ logger: false, membership: {
    verify: token => ({ id: token }),
    read: id => ({ status: ['pending', 'rejected', 'suspended'].includes(id.split('.')[1]) ? id.split('.')[1] : 'approved' }),
    isAdmin: id => id !== 'test.user.token',
  } })
  t.after(() => app.close())
  const url = '/api/v1/admin/providers'
  assert.equal((await app.inject(url)).statusCode, 401)
  assert.equal((await app.inject({ url, headers: { authorization: 'Bearer test.user.token' } })).statusCode, 403)
  for (const status of ['pending', 'rejected', 'suspended']) {
    const denied = await app.inject({ url, headers: { authorization: `Bearer test.${status}.token` } })
    assert.equal(denied.statusCode, 403)
    assert.deepEqual(denied.json(), { code: 'MEMBER_NOT_APPROVED' })
  }
  const publicHealth = await app.inject('/health')
  assert.equal(publicHealth.statusCode, 200)
  assert.deepEqual(publicHealth.json(), { status: 'ok' })
  const result = await app.inject({ url, headers: { authorization: 'Bearer test.admin.token' } })
  assert.equal(result.statusCode, 200)
  assert.equal(result.json().alerts.mode, 'test')
})

test('ECOS partial failure is distinct from a missing release and DART records a successful query', async () => {
  const date = '2026-11-25'
  const now = '2026-11-26T00:00:00.000Z'
  const health = createProviderHealth({ clock: () => Date.parse(now) })
  const rows = () => Object.fromEntries(health.snapshot().providers.map(row => [row.provider, row]))
  const observation = { status: 'published', observationDate: date, collectedAt: now }
  await health.observe('ecos', () => ({ indicators: [observation, { status: 'unavailable' }] }))
  assert.equal(rows().ecos.status, 'Healthy')
  assert.equal(rows().ecos.observationDate, date)
  assert.equal(rows().ecos.succeededAt, now)
  await health.observe('ecos', () => ({ indicators: [observation, { status: 'unavailable', code: 'ECOS_TIMEOUT' }] }))
  assert.equal(rows().ecos.status, 'Degraded')
  assert.equal(rows().ecos.errorCode, 'ECOS_TIMEOUT')
  await health.observe('dart', () => ({ filings: [{ filedAt: date }] }))
  assert.equal(rows().dart.succeededAt, now)
  assert.equal(rows().dart.observationDate, date)
})

test('DART body and partial rate-limit codes both classify as rate limited', async () => {
  const health = createProviderHealth()
  const status = () => health.snapshot().providers.find(row => row.provider === 'dart').status
  await assert.rejects(health.observe('dart', () => { throw new ProviderError(503, 'DART_PROVIDER_LIMITED') }))
  assert.equal(status(), 'Rate Limited')
  await health.observe('dart', () => ({ filingsError: 'DART_PROVIDER_LIMITED', financials: [] }))
  assert.equal(status(), 'Rate Limited')
})

test('US index snapshot observes stale provider state on the admin health endpoint', async t => {
  const app = await buildApp({ logger: false, membership: {
    verify: token => ({ id: token }), read: () => ({ status: 'approved' }), isAdmin: () => true,
  }, memberUs: {
    index: async symbol => symbol === '^GSPC'
      ? { status: 'stale', reason: 'not-published', price: 100, tradingDate: '2026-11-25' }
      : { status: 'available', price: 200, tradingDate: '2026-11-26' },
  } })
  t.after(() => app.close())
  const headers = { authorization: 'Bearer test.admin.token' }
  assert.equal((await app.inject({ url: '/api/v1/market/snapshot', headers })).statusCode, 200)
  const health = await app.inject({ url: '/api/v1/admin/providers', headers })
  const us = health.json().providers.find(row => row.provider === 'yfinance')
  assert.equal(us.status, 'Stale')
  assert.equal(us.observationDate, '2026-11-25')
  assert.equal(us.consecutiveFailures, 1)
})

test('FX malformed refresh remains stale even while its diagnostic code is redacted', async () => {
  const health = createProviderHealth()
  await health.observe('fx', () => ({ refreshError: 'INVALID_PROVIDER_RESPONSE',
    reference: { observationDate: '2026-11-25' } }))
  const fx = health.snapshot().providers.find(row => row.provider === 'fx')
  assert.equal(fx.status, 'Stale')
  assert.equal(fx.errorCode, null)
  assert.equal(fx.consecutiveFailures, 1)
})

test('KRX scheduled waiting does not clear an earlier failure or disguise an overdue publication', () => {
  const health = createProviderHealth()
  const attempt = { event: 'krx-collection', endpoint: 'idx/kospi_dd_trd', result: 'empty', latestDate: '2026-11-24' }
  const status = () => health.snapshot().providers.find(row => row.provider === 'krx').status
  health.krx({ ...attempt, pendingPublication: true })
  assert.equal(status(), 'Not Yet Collected')
  health.krx(attempt)
  assert.equal(status(), 'Stale')
  health.krx({ ...attempt, pendingPublication: true })
  assert.equal(status(), 'Stale')
  health.krx({ ...attempt, result: 'available', latestDate: '2026-11-25' })
  assert.equal(status(), 'Healthy')
})

test('DART company not found does not count as a provider outage', async () => {
  const health = createProviderHealth()
  await health.observe('dart', () => ({ filings: [] }))
  const before = health.snapshot().providers.find(row => row.provider === 'dart')
  await assert.rejects(health.observe('dart', () => { throw new ProviderError(404, 'COMPANY_NOT_FOUND') }))
  assert.deepEqual(health.snapshot().providers.find(row => row.provider === 'dart'), before)
})


test('monitoring keeps idle periods quiet, deduplicates cached failures and bounds test event history', async () => {
  let now = Date.parse('2026-11-26T00:00:00Z')
  const health = createProviderHealth({ clock: () => now, alertDelayMs: 100 })
  const rows = () => Object.fromEntries(health.snapshot().providers.map(row => [row.provider, row]))
  assert.equal(rows().fx.status, 'Not Yet Collected')
  now += 24 * 60 * 60_000
  assert.deepEqual(health.snapshot().alerts, { mode: 'test', events: [] })
  const normal = { reference: { observationDate: '2026-11-25', collectedAt: '2026-11-26T00:00:00Z' } }
  await health.observe('fx', () => withHealthMetadata({ ...normal }, { usedCache: false }))
  assert.equal(rows().fx.usedCache, false)
  const cache = attempted => health.observe('fx', () => withHealthMetadata(
    { ...normal, refreshError: 'PROVIDER_TIMEOUT' }, { usedCache: true, attempted }))
  await cache(true)
  now += 200
  await cache(false)
  assert.equal(rows().fx.consecutiveFailures, 1)
  assert.equal(rows().fx.usedCache, true)
  assert.equal(rows().fx.succeededAt, '2026-11-26T00:00:00.000Z')
  assert.equal(health.snapshot().alerts.events.length, 0)
  for (let i = 0; i < 13; i++) {
    await cache(true)
    now += 200
    await cache(true)
    await cache(true)
    await health.observe('fx', () => normal)
  }
  assert.equal(health.snapshot().alerts.events.length, 20)
  assert.deepEqual(health.snapshot().alerts.events.slice(-2).map(event => event.kind), ['incident', 'recovery'])
  assert.equal(rows().fx.consecutiveFailures, 0)
  for (let i = 0; i < 100; i++) health.krx({ event: 'krx-collection', endpoint: `ignored-${i}`, result: 'error' })
  assert.equal(rows().krx.status, 'Not Yet Collected')
})

test('yfinance counts distinct collector attempts and reports cached snapshot time separately', async () => {
  const health = createProviderHealth()
  const us = () => health.snapshot().providers.find(row => row.provider === 'yfinance')
  const asOf = '2026-11-25T22:00:00Z'
  const attempt = time => health.observe('yfinance', () => withHealthMetadata({
    status: 'stale', reason: 'provider-error', tradingDate: '2026-11-25', collectedAt: asOf,
  }, { usedCache: true, attemptedAt: time, retries: 1 }), '^GSPC')
  await attempt('2026-11-26T01:00:00Z')
  await attempt('2026-11-26T01:00:00Z')
  await attempt('2026-11-26T02:00:00Z')
  assert.equal(us().consecutiveFailures, 2)
  assert.equal(us().succeededAt, '2026-11-25T22:00:00.000Z')
  assert.equal(us().attemptedAt, '2026-11-26T02:00:00.000Z')
  assert.equal(us().retries, 1)
  assert.equal(us().usedCache, true)
})
