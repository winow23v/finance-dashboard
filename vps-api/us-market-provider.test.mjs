import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { buildApp } from './server.mjs'
import { configureMemberUsMarket, createUsMarketProvider } from './us-market-provider.mjs'

test('member US routes gate data and collection requests and preserve the last good snapshot', async t => {
  const root = await mkdtemp(join(tmpdir(), 'member-us-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const queue = join(root, 'queue')
  await Promise.all(['queue', 'indices', 'stocks'].map(name => mkdir(join(root, name))))
  const clock = () => Date.parse('2026-11-22T12:00:00Z')
  const memberUs = createUsMarketProvider({ root, queue, clock })
  assert.equal(configureMemberUsMarket({ enabled: '0', root }), undefined)
  await assert.rejects(buildApp({ memberUs }), /requires membership/)
  let status = 'pending'
  const app = await buildApp({
    logger: false, memberUs,
    membership: { verify: token => token === 'test.ok.token' ? { id: 'member' } : null, read: () => ({ status }) },
  })
  t.after(() => app.close())
  const headers = { authorization: 'Bearer test.ok.token' }
  const url = '/api/v1/market/us/stocks/ABCD/history'
  const request = '/api/v1/market/us/stocks/ABCD/requests'
  assert.equal((await app.inject(url)).statusCode, 401)
  assert.equal((await app.inject({ method: 'POST', url: request, headers })).statusCode, 403)
  assert.deepEqual(await readdir(queue), [])
  status = 'approved'
  assert.equal((await app.inject({ url, headers })).json().reason, 'not-published')
  assert.equal((await app.inject({ method: 'POST', url: request, headers })).json().reason, 'collecting')
  assert.equal((await app.inject({ method: 'POST', url: request, headers })).json().reason, 'collecting')
  assert.deepEqual(await readdir(queue), ['ABCD'])
  assert.equal((await app.inject({ url, headers })).json().reason, 'collecting')
  assert.equal((await app.inject({ method: 'POST', url: request, headers })).statusCode, 200)
  assert.equal((await app.inject({ method: 'POST', url: request, headers })).statusCode, 429)
  const raw = Array.from({ length: 260 }, (_, index) => ({
    tradingDate: new Date(Date.UTC(2026, 10, 20 - (259 - index))).toISOString().slice(0, 10),
    open: 130, high: 133, low: 120, close: 130 + index / 260, volume: 500,
  }))
  const snapshot = {
    raw, adjusted: raw.map(bar => ({ ...bar, close: bar.close - 1 })), tradingDate: '2026-11-20',
    observedAt: '2026-11-20T21:00:00Z', collectedAt: '2026-11-20T22:00:00Z', nextSessionClose: '2026-11-23T21:00:00Z',
  }
  const paths = [['stocks', 'ABCD'], ...['^GSPC', '^IXIC', '^DJI'].map(symbol => ['indices', symbol])]
  await Promise.all(paths.map(([kind, symbol]) => writeFile(join(root, kind, symbol + '.json'),
    JSON.stringify({ version: 1, symbol, snapshot, attempt: { reason: null } }))))
  const good = (await app.inject({ url, headers })).json()
  assert.equal(good.analysisStatus, 'available')
  assert.equal(good.history.bars.length, 260)
  assert.equal(good.quote.close, raw.at(-1).close)
  assert.equal(good.history.bars.at(-1).close, raw.at(-1).close - 1)
  const result = (await app.inject({ url: '/api/v1/market/snapshot', headers })).json()
  assert.equal(result.quotes.filter(quote => quote.market === 'US' && quote.status === 'available').length, 3)
  assert.equal((await app.inject({ url: '/api/v1/market/history?symbolId=dow&period=1W', headers })).json().length, 5)
  await writeFile(join(root, 'stocks', 'ABCD.json'), JSON.stringify({
    version: 1, symbol: 'ABCD', snapshot, attempt: { reason: 'rate-limited' },
  }))
  const restarted = createUsMarketProvider({ root, clock })
  const stale = await restarted.stock('ABCD')
  assert.equal(stale.status, 'stale')
  assert.equal(stale.reason, 'rate-limited')
  assert.deepEqual(stale.quote, good.quote)
})

test('short histories remain displayable but are not eligible for analysis', async t => {
  const root = await mkdtemp(join(tmpdir(), 'member-us-short-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'stocks'))
  const bar = { tradingDate: '2026-11-20', open: 10, high: 11, low: 9, close: 10, volume: 200 }
  await writeFile(join(root, 'stocks', 'NEW.json'), JSON.stringify({
    version: 1, symbol: 'NEW', snapshot: {
      raw: [bar], adjusted: [bar], tradingDate: bar.tradingDate,
      observedAt: '2026-11-20T21:00:00Z', collectedAt: '2026-11-20T21:30:00Z', nextSessionClose: '2026-11-23T21:00:00Z',
    },
  }))
  const stock = await createUsMarketProvider({ root }).stock('NEW')
  assert.equal(stock.analysisStatus, 'insufficient-history')
  assert.equal(stock.quote.change, null)
})
