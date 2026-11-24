import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { configureMemberKrx, createKrxProvider } from './krx-provider.mjs'
import { createIndexSnapshot } from './market-index-provider.mjs'
import { buildApp } from './server.mjs'

const response = rows => Response.json({ OutBlock_1: rows })

test('scheduled collection keeps old bars on errors and publishes recovered trades even if listings lag', async t => {
  const root = await mkdtemp(join(tmpdir(), 'krx-scheduled-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const symbol = '263860'
  const oldDate = '2026-11-20'
  const newDate = '2026-11-23'
  const collectedAt = '2026-11-21T00:00:00.000Z'
  const bar = { symbol, price: 100, open: 99, high: 101, low: 98, volume: 10, tradingDate: oldDate }
  const listing = { symbol, name: '지니언스', fullName: '지니언스', listedOn: '2026-11-20', market: 'KOSDAQ' }
  const oldFile = join(root, 'ohlcv-KOSDAQ-' + oldDate + '.json')
  const oldHistory = JSON.stringify({ date: oldDate, rows: [[symbol, 99, 101, 98, 100, 10]] })
  await Promise.all([
    writeFile(oldFile, oldHistory),
    ...[['ksq_isu_base_info', listing], ['ksq_bydd_trd', bar]].map(([name, row]) =>
      writeFile(join(root, 'sto-' + name + '.json'), JSON.stringify({
        version: 1, history: [], data: { date: oldDate, collectedAt, rows: [row] },
      }))),
  ])
  const log = []
  let now = Date.parse('2026-11-23T07:31:00Z')
  let available = false
  let checks = 0
  const provider = createKrxProvider({ scheduled: true, root, key: 'fixture', clock: () => now,
    log: event => log.push(event),
    fetchImpl(url) {
      checks++
      if (!url.pathname.endsWith('/ksq_bydd_trd')) return new Response(null, { status: 403 })
      if (!available) return new Response(null, { status: 503 })
      return response([{ BAS_DD: '20261123', MKT_NM: 'KOSDAQ', ISU_CD: symbol, ISU_NM: '지니언스',
        TDD_CLSPRC: '105', TDD_OPNPRC: '100', TDD_HGPRC: '107', TDD_LWPRC: '97', ACC_TRDVOL: '20' }])
    },
  })
  assert.equal((await provider.stockHistory(symbol)).latestDate, oldDate)
  assert.equal(checks, 0)
  await provider.collect()
  const stale = await provider.stockHistory(symbol)
  assert.equal(stale.latestDate, oldDate)
  assert.equal(stale.collectedAt, collectedAt)
  assert.equal(stale.reason, 'provider-error')
  assert.equal(stale.errorCode, 'PROVIDER_UNAVAILABLE')
  assert.deepEqual(log.filter(entry => entry.endpoint.endsWith('/ksq_bydd_trd') && entry.event === 'krx-request')
    .map(({ attempt, httpStatus }) => [attempt, httpStatus]), [[1, 503], [2, 503], [3, 503]])
  assert.equal(log.filter(entry => entry.httpStatus === 403 && entry.attempt > 1).length, 0)
  available = true
  now = Date.parse('2026-11-23T08:31:00Z')
  await provider.collect()
  const list = await provider.stocks({ market: 'KOSDAQ', symbol })
  const detail = await provider.stockHistory(symbol)
  assert.equal(list.listingDate, oldDate)
  assert.equal(list.trades.tradingDate, newDate)
  assert.equal(list.trades.collectedAt, detail.collectedAt)
  assert.deepEqual(list.items[0].quote, detail.quote)
  assert.equal(detail.latestDate, newDate)
  assert.equal(detail.reason, null)
  assert.deepEqual(detail.history.bars.map(row => row.tradingDate), [oldDate, newDate])
  assert.equal(await readFile(oldFile, 'utf8'), oldHistory)
  const snapshot = JSON.parse(await readFile(join(root, 'sto-ksq_bydd_trd.json'), 'utf8'))
  assert.deepEqual(snapshot.history.map(entry => entry.result), ['error', 'available'])
})

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
      { BAS_DD: '20261120', ISU_CD: '005930', ISU_NM: '삼성전자', MKT_NM: 'KOSPI',
        TDD_CLSPRC: '100,400', TDD_OPNPRC: '100000', TDD_HGPRC: '101000', TDD_LWPRC: '99000', ACC_TRDVOL: '1,234' },
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
  assert.equal(history.stoppedReason, 'no-trades')
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


test('a member cache supports 500 shared sessions without fetches and stops before listing', async t => {
  const root = await mkdtemp(join(tmpdir(), 'krx-member-history-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const latest = '2026-11-20'
  const dates = []
  for (let offset = 0; dates.length < 501; offset++) {
    const date = new Date(Date.parse(latest) - offset * 86_400_000)
    if (![0, 6].includes(date.getUTCDay())) dates.push(date.toISOString().slice(0, 10))
  }
  const symbols = ['005930', '000660', '263860']
  const state = (file, rows) => writeFile(join(root, file + '.json'),
    JSON.stringify({ version: 1, history: [], data: { date: latest, rows } }))
  const bars = symbols.map(symbol => [symbol, 100, 110, 98, 105, 1000])
  await Promise.all([
    state('sto-stk_bydd_trd', symbols.map(symbol => ({
      symbol, price: 105, open: 100, high: 110, low: 98, volume: 1000, tradingDate: latest,
    }))),
    state('sto-stk_isu_base_info', symbols.map(symbol => ({
      symbol, market: 'KOSPI', name: symbol, fullName: symbol,
      listedOn: symbol === '263860' ? dates[2] : '2010-01-04',
    }))),
    state('sto-ksq_isu_base_info', [{ symbol: '123456', market: 'KOSDAQ', fullName: 'Fixture' }]),
  ])
  for (const date of dates) {
    await writeFile(join(root, 'ohlcv-KOSPI-' + date + '.json'), JSON.stringify({ date, rows: bars }))
  }
  const provider = configureMemberKrx({ enabled: '1', root, key: '',
    clock: () => Date.parse('2026-11-21T08:00:00Z'),
    fetchImpl: () => assert.fail('Reading/planning must never contact KRX'),
  })
  const plan = await provider.backfillPlan(145)
  assert.equal(plan.maxRequestsPerRun, 300)
  assert.equal(plan.markets.KOSPI.cachedSessions, 500)
  assert.equal(plan.markets.KOSPI.minimumAdditionalSessions, 0)
  const [samsung, hynix, listedRecently] = await Promise.all(symbols.map(symbol => provider.stockHistory(symbol)))
  for (const result of [samsung, hynix]) {
    assert.equal(result.history.bars.length, 500)
    assert.equal(result.history.bars[0].tradingDate, dates[499])
    assert.equal(result.history.bars.at(-1).tradingDate, latest)
  }
  assert.equal(listedRecently.history.bars.length, 3)
  assert.equal(listedRecently.stoppedAt, dates[3])
  assert.equal(listedRecently.stoppedReason, 'pre-listing')
})

test('backfill does not start historical requests after a latest session 429', async t => {
  const root = await mkdtemp(join(tmpdir(), 'krx-backfill-throttle-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  let calls = 0
  const provider = createKrxProvider({
    key: 'fixture', root, clock: () => Date.parse('2026-11-21T08:00:00Z'),
    fetchImpl: () => { calls++; return new Response('', { status: 429 }) },
  })
  await assert.rejects(provider.backfill(1), { code: 'PROVIDER_RATE_LIMITED' })
  assert.equal(calls, 1)
})
