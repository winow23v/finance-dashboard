import assert from 'node:assert/strict'
import test from 'node:test'
import { createProviderHealth } from './health-provider.mjs'
import { ProviderError } from './public-provider.mjs'
import { buildApp } from './server.mjs'

test('provider monitoring suppresses scheduled waiting, redacts errors and deduplicates alert/recovery events', async () => {
  let now = Date.parse('2026-11-26')
  const health = createProviderHealth({ clock: () => now, alertDelayMs: 1_000 })
  await health.observe('yfinance', () => ({ status: 'unavailable', reason: 'collecting' }))
  assert.equal(health.snapshot().providers.find(row => row.provider === 'yfinance').status, 'Healthy')
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
    read: () => ({ status: 'approved' }),
    isAdmin: id => id === 'test.admin.token',
  } })
  t.after(() => app.close())
  const url = '/api/v1/admin/providers'
  assert.equal((await app.inject(url)).statusCode, 401)
  assert.equal((await app.inject({ url, headers: { authorization: 'Bearer test.user.token' } })).statusCode, 403)
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
    index: async () => ({ status: 'stale', reason: 'not-published', price: 100, tradingDate: '2026-11-25' }),
  } })
  t.after(() => app.close())
  const headers = { authorization: 'Bearer test.admin.token' }
  assert.equal((await app.inject({ url: '/api/v1/market/snapshot', headers })).statusCode, 200)
  const health = await app.inject({ url: '/api/v1/admin/providers', headers })
  const us = health.json().providers.find(row => row.provider === 'yfinance')
  assert.equal(us.status, 'Stale')
  assert.equal(us.observationDate, '2026-11-25')
})
