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
