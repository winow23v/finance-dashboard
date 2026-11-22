import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { configureMemberKrx, createKrxProvider } from './krx-provider.mjs'
import { createIndexSnapshot } from './market-index-provider.mjs'
import { buildApp } from './server.mjs'

const response = rows => Response.json({ OutBlock_1: rows })

test('member KRX is opt-in and cannot be mounted without membership', async t => {
  const fetchImpl = () => assert.fail('disabled provider must not call KRX')
  assert.equal(configureMemberKrx({ enabled: '0', key: 'fixture', fetchImpl }), undefined)
  await assert.rejects(buildApp({ memberKrx: {}, logger: false }), /requires membership/)
  const app = await buildApp({ logger: false, membership: {
    verify: () => ({ id: 'member' }), read: () => ({ status: 'approved' }),
  } })
  t.after(() => app.close())
  const headers = { host: 'public.example', authorization: 'Bearer test.good.token' }
  const overview = await app.inject({ url: '/api/v1/market/kr/overview', headers })
  assert.equal(overview.statusCode, 503)
  assert.equal(overview.json().code, 'KRX_LOCAL_PROVIDER_DISABLED')
  const snapshot = await app.inject({ url: '/api/v1/market/snapshot', headers })
  assert.equal(snapshot.statusCode, 200)
  assert.ok(snapshot.json().quotes.every(quote => quote.status === 'unavailable'
    && quote.reason === 'provider-not-configured' && quote.price === null))
})

test('member KRX checks current approval before accessing or reusing the daily close cache', async t => {
  const root = await mkdtemp(join(tmpdir(), 'member-krx-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const calls = []
  const memberKrx = configureMemberKrx({
    enabled: '1', key: 'fixture', root, clock: () => Date.parse('2026-11-21T08:00:00Z'),
    fetchImpl(url, request) {
      calls.push(url.pathname)
      assert.equal(url.searchParams.get('basDd'), '20261120')
      assert.equal(request.headers.AUTH_KEY, 'fixture')
      if (url.pathname.endsWith('/kospi_dd_trd')) return response([
        { IDX_CLSS: 'KOSPI', IDX_NM: '코스피', BAS_DD: '20261120', CLSPRC_IDX: '4869.96' },
      ])
      return new Response('', { status: 403 })
    },
  })
  let status = 'pending'
  const app = await buildApp({ logger: false, memberKrx, membership: {
    verify: token => token === 'test.good.token' ? { id: 'member' } : null,
    read: () => ({ status }),
  } })
  t.after(() => app.close())
  const urls = ['/api/v1/market/snapshot', '/api/v1/market/kr/overview',
    '/api/v1/market/kr/stocks?market=KOSPI', '/api/v1/market/kr/stocks/005930/history']
  const headers = { host: 'public.example', authorization: 'Bearer test.good.token' }
  for (const url of urls) {
    assert.equal((await app.inject({ url, headers: { host: headers.host } })).statusCode, 401)
    assert.equal((await app.inject({ url, headers })).statusCode, 403)
  }
  assert.deepEqual(calls, [])
  status = 'approved'
  const [snapshot, shared] = await Promise.all([app.inject({ url: urls[0], headers }), app.inject({ url: urls[0], headers })])
  assert.equal(snapshot.statusCode, 200)
  assert.deepEqual(snapshot.json(), shared.json())
  const [kospi, kosdaq, spx] = snapshot.json().quotes
  assert.equal(kospi.price, 4869.96)
  assert.equal(kospi.tradingDate, '2026-11-20')
  assert.equal(kosdaq.status, 'unavailable')
  assert.equal(kosdaq.reason, 'provider-error')
  assert.equal(kosdaq.errorCode, 'KRX_ACCESS_DENIED')
  assert.equal(spx.reason, 'provider-not-configured')
  assert.equal(calls.length, 2)
  const overview = await app.inject({ url: urls[1], headers })
  assert.equal(overview.statusCode, 200)
  assert.equal(overview.json().reason, 'provider-error')
  const stocks = await app.inject({ url: urls[2], headers })
  assert.equal(stocks.statusCode, 200)
  assert.equal(stocks.json().listings.reason, 'provider-error')
  assert.equal((await app.inject({ url: urls[3], headers })).statusCode, 503)
  const uniqueCalls = new Set(calls)
  assert.equal(calls.length, uniqueCalls.size)
  status = 'suspended'
  assert.equal((await app.inject({ url: urls[0], headers })).statusCode, 403)
  assert.equal(calls.length, uniqueCalls.size)
})

test('selects the named index, persists it, and keeps the actual trade date during retries', async t => {
  const root = await mkdtemp(join(tmpdir(), 'krx-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  let now = Date.parse('2026-11-21T08:00:00Z')
  const dates = []
  const ok = { IDX_CLSS: 'KOSPI', IDX_NM: '코스피', BAS_DD: '20261120',
    CLSPRC_IDX: '4,869.96', CMPPREVDD_IDX: '-267.93', FLUC_RT: '-5.21', ACC_TRDVOL: '-' }
  const options = { key: 'fixture', root, clock: () => now, fetchImpl(url, request) {
    assert.equal(request.headers.AUTH_KEY, 'fixture')
    const date = url.searchParams.get('basDd')
    dates.push(date)
    if (date === '20261120') return response([{ ...ok, IDX_NM: '코스피 (외국주포함)', CLSPRC_IDX: '7000' }, ok])
    return dates.length === 2 ? response([]) : new Response('', { status: 403 })
  } }
  const first = createKrxProvider(options)
  const [quote, shared] = await Promise.all([first.indices('KOSPI'), first.indices('KOSPI')])
  assert.deepEqual(quote, shared)
  assert.equal(quote.price, 4869.96)
  assert.equal(quote.volume, null)
  assert.equal(quote.reason, 'weekend')
  assert.deepEqual(dates, ['20261120'])
  const restarted = createKrxProvider(options)
  assert.equal((await restarted.indices('KOSPI')).collectedAt, quote.collectedAt)
  now = Date.parse('2026-11-23T07:31:00Z')
  const pending = await restarted.indices('KOSPI')
  assert.equal(pending.reason, 'not-published')
  assert.equal(pending.tradingDate, '2026-11-20')
  assert.equal(pending.status, 'stale')
  await restarted.indices('KOSPI')
  assert.deepEqual(dates, ['20261120', '20261123'])
  now = Date.parse('2026-11-23T08:31:00Z')
  const denied = await restarted.indices('KOSPI')
  assert.equal(denied.errorCode, 'KRX_ACCESS_DENIED')
  assert.equal(denied.tradingDate, '2026-11-20')
  assert.equal(denied.price, 4869.96)
})

test('joins KRX short codes, preserves preferred shares, and protects local stock routes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'krx-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const common = { LIST_DD: '19750611', MKT_TP_NM: 'KOSPI', ISU_ABBRV: '삼성전자', ISU_ENG_NM: 'SamsungElectronics' }
  const krx = createKrxProvider({ key: 'fixture', root, clock: () => Date.parse('2026-11-21T08:00:00Z'),
    fetchImpl: url => url.pathname.endsWith('base_info') ? response([
      { ...common, ISU_CD: 'KR7005930003', ISU_SRT_CD: '005930', KIND_STKCERT_TP_NM: '보통주' },
      { ...common, ISU_CD: 'KR7005931001', ISU_SRT_CD: '005935', KIND_STKCERT_TP_NM: '우선주' },
    ]) : response([
      { BAS_DD: '20261120', ISU_CD: '005930', ISU_NM: '삼성전자', MKT_NM: 'KOSPI', TDD_CLSPRC: '100,400', ACC_TRDVOL: '1,234' },
    ]),
  })
  const app = await buildApp({ logger: false, localKrx: krx, localIndexResearch: createIndexSnapshot(undefined, krx),
    membership: { verify: token => token === 'test.good.token' || token === 'test.stop.token' ? { id: token } : null,
      read: id => ({ status: id === 'test.stop.token' ? 'suspended' : 'approved' }) } })
  t.after(() => app.close())
  const url = '/api/v1/market/kr/stocks?market=KOSPI&q=Samsung'
  assert.equal((await app.inject(url)).statusCode, 401)
  const headers = { host: '127.0.0.1:5174', authorization: 'Bearer test.good.token' }
  assert.equal((await app.inject({ url, headers: { ...headers, authorization: 'Bearer test.stop.token' } })).statusCode, 403)
  assert.equal((await app.inject({ url, headers: { ...headers, host: 'public.example' } })).statusCode, 503)
  const actual = await app.inject({ url, headers })
  assert.equal(actual.statusCode, 200)
  const { items } = actual.json()
  assert.deepEqual(items.map(row => [row.symbol, row.shareClass, row.quote?.price ?? null]),
    [['005930', '보통주', 100400], ['005935', '우선주', null]])
  assert.equal(items[0].quote.volume, 1234)
  assert.equal(items[0].quote.change, null)
})

test('history excludes closed dates, stops at an invalid session, and ranks only same-date traded rows', async t => {
  const root = await mkdtemp(join(tmpdir(), 'krx-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const requested = []
  const krx = createKrxProvider({
    key: 'fixture', root, clock: () => Date.parse('2026-11-21T08:00:00Z'),
    fetchImpl(url) {
      const market = url.pathname.includes('stk_') ? 'KOSPI' : 'KOSDAQ'
      const symbol = market === 'KOSPI' ? '005930' : '247540'
      const date = url.searchParams.get('basDd')
      const row = { BAS_DD: date, ISU_CD: symbol, ISU_NM: symbol, MKT_NM: market,
        TDD_CLSPRC: '105', TDD_OPNPRC: '100', TDD_HGPRC: '110', TDD_LWPRC: '99',
        ACC_TRDVOL: '1000', MKTCAP: '5000', FLUC_RT: market === 'KOSPI' ? '5' : '-5' }
      if (url.pathname.endsWith('base_info')) return response([
        { ISU_SRT_CD: symbol, ISU_ABBRV: market === 'KOSPI' ? '삼성전자' : '에코프로비엠',
          ISU_NM: market === 'KOSPI' ? '삼성전자보통주' : '에코프로비엠',
          LIST_DD: '19750611', MKT_TP_NM: market },
      ])
      requested.push([market, date])
      if (date === '20261119') return response([])
      if (date === '20261117') return response([
        { ...row, ACC_TRDVOL: '0' }, { ...row, ISU_CD: '000660' },
      ])
      return response([row])
    },
  })
  await krx.backfill(3)
  const history = await krx.stockHistory('005930')
  assert.deepEqual(history.history.bars.map(row => row.tradingDate), ['2026-11-18', '2026-11-20'])
  assert.equal(history.stoppedAt, '2026-11-17')
  assert.equal(history.stoppedReason, 'missing-observation')
  assert.equal(history.history.adjustment, 'unadjusted')
  const overview = await krx.overview()
  assert.equal(overview.tradingDate, '2026-11-20')
  assert.equal(overview.leaders.advances[0].symbol, '005930')
  assert.equal(overview.leaders.advances[0].name, '삼성전자보통주')
  assert.equal(overview.marketTiles.KOSPI[0].shortName, '삼성전자')
  assert.equal(overview.marketTiles.KOSPI[0].mapped, true)
  assert.ok(overview.marketTiles.KOSDAQ.every(row => row.market === 'KOSDAQ'))
  assert.equal(overview.leaders.declines[0].symbol, '247540')
  const before = requested.length
  const app = await buildApp({ logger: false, localKrx: krx, membership: {
    verify: token => ({ id: token }), read: id => ({ status: id === 'test.stop.token' ? 'suspended' : 'approved' }),
  } })
  t.after(() => app.close())
  for (const url of ['/api/v1/market/kr/stocks/005930/history', '/api/v1/market/kr/overview']) {
    assert.equal((await app.inject(url)).statusCode, 401)
    assert.equal((await app.inject({ url, headers: { host: '127.0.0.1', authorization: 'Bearer test.stop.token' } })).statusCode, 403)
    assert.equal((await app.inject({ url, headers: { host: 'public.example', authorization: 'Bearer test.good.token' } })).statusCode, 503)
    assert.equal((await app.inject({ url, headers: { host: '127.0.0.1', authorization: 'Bearer test.good.token' } })).statusCode, 200)
  }
  assert.equal(requested.length, before)
})

test('backfill stops on HTTP 429 and a rerun skips the saved latest session', async t => {
  const root = await mkdtemp(join(tmpdir(), 'krx-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const clock = () => Date.parse('2026-11-21T08:00:00Z')
  const log = []
  const get = (delayDate) => (url) => {
    const date = url.searchParams.get('basDd')
    log.push(date)
    if (date === delayDate) return new Response('', { status: 429 })
    const market = url.pathname.includes('stk_') ? 'KOSPI' : 'KOSDAQ'
    return response([{ BAS_DD: date, MKT_NM: market, ISU_CD: '005930', ISU_NM: '삼성전자',
      TDD_CLSPRC: '105', TDD_OPNPRC: '100', TDD_HGPRC: '110', TDD_LWPRC: '99', ACC_TRDVOL: '1000' }])
  }
  await assert.rejects(createKrxProvider({ key: 'fixture', root, clock, fetchImpl: get('20261119') }).backfill(1),
    { code: 'PROVIDER_RATE_LIMITED' })
  assert.deepEqual(log, ['20261120', '20261119'])
  const result = await createKrxProvider({ key: 'fixture', root, clock, fetchImpl: get(null) }).backfill(1)
  assert.deepEqual(log.slice(2), ['20261119', '20261120', '20261119'])
  assert.equal(result.KOSPI.sessions, 1)
  assert.equal(result.KOSDAQ.sessions, 1)
})
