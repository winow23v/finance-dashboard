import assert from 'node:assert/strict'
import test from 'node:test'
import { createKrxIntradayProvider } from './kr-intraday-provider.mjs'
import { ProviderError } from './public-provider.mjs'

const date = '2026-11-25'
const instrument = { market: 'KOSPI', symbol: '005930', name: '삼성전자' }
const sample = { ...instrument, tradingDate: date, observedAt: date + 'T11:10:00+09:00', venue: null,
  session: 'regular', price: 101, previousClose: 100, open: 100, high: 102, low: 99,
  volume: 250, turnover: null, delayMinutes: null }
const options = { clock: () => Date.parse(date + 'T03:00Z'), tradingSession: () => ({ open: true, tradingDate: date }),
  approvalFor: () => ({ memberDisplay: true, source: 'fixture', cacheTtlMs: 1_000 }) }

test('unapproved or closed sources never call the wire reader', async () => {
  const read = () => assert.fail('wire reader must remain unused')
  assert.equal((await createKrxIntradayProvider({ ...options, approvalFor: () => undefined, read }).quote(instrument)).reason, 'not-configured')
  assert.equal((await createKrxIntradayProvider({ ...options, tradingSession: () => ({ open: false, tradingDate: date }), read }).quote(instrument)).reason, 'market-closed')
})

test('duplicates share one request and retain an unknown venue without altering finalized closes', async () => {
  let calls = 0
  const provider = createKrxIntradayProvider({ ...options, read: async () => { calls++; return sample } })
  const [first, second] = await Promise.all([provider.quote(instrument), provider.quote(instrument)])
  assert.deepEqual(first, second)
  assert.equal(first.basis, 'intraday')
  assert.equal(first.venue, null)
  assert.equal(first.changePercent, 1)
  assert.equal(first.symbol, '005930')
  assert.deepEqual(await provider.quote(instrument), first)
  assert.equal(calls, 1)
  const staleDay = createKrxIntradayProvider({ ...options, read: async () => ({ ...sample, tradingDate: '2026-11-24' }) })
  assert.equal((await staleDay.quote(instrument)).reason, 'invalid-observation')
})

test('honors Retry-After and never retries inside the same quote', async () => {
  let now = options.clock()
  let calls = 0
  const provider = createKrxIntradayProvider({ ...options, clock: () => now, read: async () => {
    if (++calls === 1) throw Object.assign(new ProviderError(503, 'PROVIDER_RATE_LIMITED'), { retryAfterMs: 2_000 })
    return sample
  } })
  assert.equal((await provider.quote(instrument)).reason, 'rate-limited')
  assert.equal((await provider.quote(instrument)).reason, 'rate-limited')
  assert.equal(calls, 1)
  now += 2_000
  assert.equal((await provider.quote(instrument)).status, 'available')
})
