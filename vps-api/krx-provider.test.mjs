import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, rmdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { configureMemberKrx, createKrxProvider } from './krx-provider.mjs'
import { createKrxCalendar, krxCollectionSession } from './krx-calendar-provider.mjs'
import { createIndexSnapshot } from './market-index-provider.mjs'
import { buildApp, registerKrxCollector } from './server.mjs'

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
  const tradeCalls = []
  const provider = createKrxProvider({ scheduledOnly: true, root, key: 'fixture', clock: () => now,
    log: event => log.push(event),
    fetchImpl(url) {
      checks++
      if (url.pathname.endsWith('/stk_bydd_trd')) {
        tradeCalls.push('KOSPI')
        return response([{ BAS_DD: '20261123', MKT_NM: 'KOSPI', ISU_CD: '005930', ISU_NM: '삼성전자',
          TDD_CLSPRC: '105', TDD_OPNPRC: '100', TDD_HGPRC: '107', TDD_LWPRC: '97', ACC_TRDVOL: '20' }])
      }
      if (!url.pathname.endsWith('/ksq_bydd_trd')) return new Response(null, { status: 403 })
      tradeCalls.push('KOSDAQ')
      if (!available) return new Response(null, { status: 503 })
      return response([{ BAS_DD: '20261123', MKT_NM: 'KOSDAQ', ISU_CD: symbol, ISU_NM: '지니언스',
        TDD_CLSPRC: '105', TDD_OPNPRC: '100', TDD_HGPRC: '107', TDD_LWPRC: '97', ACC_TRDVOL: '20' }])
    },
  })
  assert.equal((await provider.stockHistory(symbol)).latestDate, oldDate)
  assert.equal(checks, 0)
  await provider.collect()
  assert.equal((await provider.stocks({ market: 'KOSPI' })).trades.tradingDate, newDate)
  assert.deepEqual(tradeCalls, ['KOSPI', 'KOSDAQ', 'KOSDAQ', 'KOSDAQ'])
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
    enabled: '1', key: 'fixture', root, clock: () => Date.parse('2026-11-20T08:00:00Z'),
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
  await app.inject({ url: urls[2], headers })
  assert.deepEqual(calls, [])
  await memberKrx.collect()
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
  assert.equal(calls.length, 6)
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


test('a member cache supports 500 shared sessions without fetches and stops before listing', async t => {
  const root = await mkdtemp(join(tmpdir(), 'krx-member-history-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const latest = '2026-11-20'
  const calendar = createKrxCalendar()
  const dates = []
  for (let offset = 0; dates.length < 501; offset++) {
    const date = new Date(Date.parse(latest) - offset * 86_400_000)
    const session = date.toISOString().slice(0, 10)
    if (!calendar.closed(session)) dates.push(session)
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
  assert.ok(!dates.includes('2026-10-09'))
  const [samsung, hynix, listedRecently] = await Promise.all(symbols.map(symbol => provider.stockHistory(symbol)))
  for (const result of [samsung, hynix]) {
    assert.equal(result.history.bars.length, 500)
    assert.ok(result.history.bars.every(bar => !calendar.closed(bar.tradingDate)))
    assert.equal(result.history.bars[0].tradingDate, dates[499])
    assert.equal(result.history.bars.at(-1).tradingDate, latest)
  }
  assert.equal(listedRecently.history.bars.length, 3)
  assert.equal(listedRecently.stoppedAt, null)
  assert.equal(listedRecently.stoppedReason, null)
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

test('member collector reserves windows, retains older OHLCV and accepts trades independently of the listing publication', async t => {
  const root = await mkdtemp(join(tmpdir(), 'krx-scheduled-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  let now = Date.parse('2026-11-20T07:00:00Z')
  let published = false
  const calls = []
  const opts = { enabled: '1', root, key: 'fixture', clock: () => now, fetchImpl(url) {
    const date = url.searchParams.get('basDd')
    const path = url.pathname
    calls.push([date, path])
    if (path.endsWith('/stk_isu_base_info')) return date === '20261120' ? response([
      { LIST_DD: '19750611', MKT_TP_NM: 'KOSPI', ISU_ABBRV: '삼성전자', ISU_NM: '삼성전자', ISU_SRT_CD: '005930' },
    ]) : response([])
    if (path.endsWith('/stk_bydd_trd') && (date === '20261120' || published)) return response([
      { BAS_DD: date, MKT_NM: 'KOSPI', ISU_CD: '005930', ISU_NM: '삼성전자',
        TDD_CLSPRC: date === '20261120' ? '100' : '102', TDD_OPNPRC: '100',
        TDD_HGPRC: '103', TDD_LWPRC: '99', ACC_TRDVOL: '10' },
    ])
    return response([])
  } }
  let member = configureMemberKrx(opts)
  await member.collect()
  assert.equal(calls.length, 6)
  now = Date.parse('2026-11-23T06:59:00Z')
  assert.equal((await member.stockHistory('005930')).history.bars[0].tradingDate, '2026-11-20')
  assert.equal(calls.length, 6)
  now = Date.parse('2026-11-23T07:00:00Z')
  await Promise.all([member.collect(), member.collect()])
  assert.equal(calls.length, 12)
  let stock = await member.stockHistory('005930')
  assert.equal(stock.reason, 'not-published')
  assert.equal(stock.quote.price, 100)
  member = configureMemberKrx(opts)
  await member.collect()
  assert.equal(calls.length, 12)
  published = true
  now = Date.parse('2026-11-23T07:30:00Z')
  await member.collect()
  stock = await member.stockHistory('005930')
  assert.equal(stock.quote.price, 102)
  assert.equal(stock.collectedAt, '2026-11-23T07:30:00.000Z')
  assert.deepEqual(stock.history.bars.map(bar => bar.tradingDate), ['2026-11-20', '2026-11-23'])
  assert.ok(stock.afterHours.every(row => row.price === null && row.eligibility === 'unknown' && row.connectionCheckedAt === null))
  now = Date.parse('2026-11-23T11:15:00Z')
  await member.collect()
  stock = await member.stockHistory('005930')
  assert.deepEqual(stock.afterHours.map(row => row.venue), ['KRX', 'NXT'])
  assert.ok(stock.afterHours.every(row => row.status === 'provider-unavailable' &&
    row.price === null && row.connectionCheckedAt === '2026-11-23T11:15:00.000Z'))
  assert.equal(calls.filter(([date, path]) => date === '20261123' && path.endsWith('/stk_bydd_trd')).length, 2)
})

test('scheduled rate limiting stops other endpoints until the next allowed window', async t => {
  const root = await mkdtemp(join(tmpdir(), 'krx-rate-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  let now = Date.parse('2026-11-23T07:00:00Z')
  let calls = 0
  const options = { enabled: '1', root, key: 'fixture', clock: () => now, fetchImpl() {
    calls++
    return calls === 1 ? new Response(null, { status: 503 })
      : new Response(null, { status: 429, headers: { 'retry-after': '3600' } })
  } }
  let member = configureMemberKrx(options)
  await member.collect()
  assert.equal((await member.indices('KOSPI')).errorCode, 'PROVIDER_RATE_LIMITED')
  assert.equal(calls, 2)
  now = Date.parse('2026-11-23T07:31:00Z')
  member = configureMemberKrx(options)
  await member.collect()
  assert.equal(calls, 2)
  now = Date.parse('2026-11-23T08:30:00Z')
  await member.collect()
  assert.equal(calls, 3)
})

test('KST schedule handles weekends, holidays, next-session retry, year coverage and special closes', () => {
  const calendar = createKrxCalendar()
  const at = date => krxCollectionSession(Date.parse(date), calendar)
  assert.equal(at('2026-11-22T12:00Z').canCollect, false)
  assert.equal(at('2026-12-25T08:00Z').canCollect, false)
  assert.equal(at('2026-07-17T08:00Z').canCollect, false)
  assert.equal(at('2026-11-22T16:00Z').today, '2026-11-23')
  assert.equal(at('2026-11-22T23:00Z').date, '2026-11-20')
  assert.equal(at('2026-11-22T23:00Z').canCollect, true)
  assert.equal(at('2026-11-23T07:00Z').date, '2026-11-23')
  assert.equal(at('2026-11-19T07:59Z').date, '2026-11-18')
  assert.equal(at('2026-11-19T08:00Z').date, '2026-11-19')
  assert.equal(at('2027-01-06T08:00Z').canCollect, false)
  const override = createKrxCalendar('{"years":[2027],"closed":["2027-01-07"],"regularClose":{"2027-01-06":"13:00"},"afterClose":{"2027-01-06":"20:30"}}')
  assert.equal(krxCollectionSession(Date.parse('2027-01-06T07:00Z'), override).afterCheckAt, '2027-01-06T11:45:00.000Z')
  assert.equal(krxCollectionSession(Date.parse('2027-01-07T07:00Z'), override).canCollect, false)
})

test('scheduled OHLCV persistence failure retains the last successful close', async t => {
  const root = await mkdtemp(join(tmpdir(), 'krx-write-failure-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  let now = Date.parse('2026-11-20T07:00:00Z')
  const fetched = []
  const member = configureMemberKrx({ enabled: '1', root, key: 'fixture', clock: () => now, fetchImpl(url) {
    const date = url.searchParams.get('basDd')
    if (url.pathname.endsWith('/stk_isu_base_info')) return response([
      { LIST_DD: '19750611', MKT_TP_NM: 'KOSPI', ISU_ABBRV: '삼성전자', ISU_NM: '삼성전자', ISU_SRT_CD: '005930' },
    ])
    if (!url.pathname.endsWith('/stk_bydd_trd')) return response([])
    fetched.push(date)
    return response([{ BAS_DD: date, MKT_NM: 'KOSPI', ISU_CD: '005930', ISU_NM: '삼성전자',
      TDD_CLSPRC: date === '20261120' ? '100' : '102', TDD_OPNPRC: '100',
      TDD_HGPRC: '103', TDD_LWPRC: '99', ACC_TRDVOL: '10' }])
  } })
  await member.collect()
  const blocked = join(root, 'ohlcv-KOSPI-2026-11-23.json')
  await mkdir(blocked)
  now = Date.parse('2026-11-23T07:00:00Z')
  await member.collect()
  const fallback = await member.stockHistory('005930')
  assert.equal(fallback.reason, 'provider-error')
  assert.equal(fallback.quote.price, 100)
  assert.equal(fallback.latestDate, '2026-11-20')
  assert.deepEqual(fallback.history.bars.map(bar => bar.tradingDate), ['2026-11-20'])
  await member.collect()
  assert.deepEqual(fetched, ['20261120', '20261123'])
  await rmdir(blocked)
  now = Date.parse('2026-11-23T07:30:00Z')
  await member.collect()
  assert.equal((await member.stockHistory('005930')).quote.price, 102)
})

test('Fastify shutdown stops the timer and drains the current run', async () => {
  const app = await buildApp({ logger: false })
  let runs = 0
  let completed = false
  registerKrxCollector(app, { async collect(signal) {
    runs++
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
    completed = true
  } }, 5)
  await app.ready()
  await new Promise(resolve => setTimeout(resolve, 15))
  assert.equal(runs, 1)
  await app.close()
  assert.equal(completed, true)
  await new Promise(resolve => setTimeout(resolve, 15))
  assert.equal(runs, 1)
})

test('daily trade download can exceed the old 3.5 second limit', async t => {
  const root = await mkdtemp(join(tmpdir(), 'krx-slow-trade-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const log = []
  const provider = createKrxProvider({ root, key: 'fixture', log: entry => log.push(entry),
    clock: () => Date.parse('2026-11-23T08:31:00Z'),
    async fetchImpl(url, { signal }) {
      if (!url.pathname.endsWith('/stk_bydd_trd')) return response([])
      await delay(3600, undefined, { signal })
      return response([{ BAS_DD: '20261123', MKT_NM: 'KOSPI', ISU_CD: '005930', ISU_NM: '삼성전자',
        TDD_CLSPRC: '105', TDD_OPNPRC: '100', TDD_HGPRC: '107', TDD_LWPRC: '97', ACC_TRDVOL: '20' }])
    },
  })
  const result = await provider.stocks({ market: 'KOSPI' })
  assert.equal(result.trades.tradingDate, '2026-11-23')
  const entry = log.find(item => item.event === 'krx-request' && item.endpoint === 'sto/stk_bydd_trd')
  assert.equal(entry.httpStatus, 200)
  assert.equal(entry.code, null)
  assert.ok(entry.elapsedMs >= 3500)
})

test('HTTP 200 body timeout and transient network errors consume separate requests before recovery', async t => {
  const root = await mkdtemp(join(tmpdir(), 'krx-body-deadline-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const log = []
  let calls = 0
  const provider = createKrxProvider({ root, key: 'fixture', log: entry => log.push(entry),
    clock: () => Date.parse('2026-11-23T08:31:00Z'),
    async fetchImpl(_url, { signal }) {
      calls++
      if (calls === 1) {
        return new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"OutBlock_1":'))
            signal.addEventListener('abort', () => controller.error(signal.reason), { once: true })
          },
        }))
      }
      if (calls === 2) throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } })
      return response([{ IDX_CLSS: 'KOSPI', IDX_NM: '코스피', BAS_DD: '20261123', CLSPRC_IDX: '105' }])
    },
  })
  // AbortSignal.timeout uses an unreferenced timer, as a fetch socket normally keeps the process alive.
  const keepAlive = setTimeout(() => {}, 12_000)
  t.after(() => clearTimeout(keepAlive))
  assert.equal((await provider.indices('KOSPI')).price, 105)
  assert.equal(calls, 3)
  const requests = log.filter(entry => entry.event === 'krx-request')
  assert.deepEqual(requests.map(({ attempt, httpStatus, code }) => [attempt, httpStatus, code]), [
    [1, 200, 'PROVIDER_TIMEOUT'], [2, null, 'PROVIDER_CONNECTION_ERROR'], [3, 200, null],
  ])
  assert.ok(requests[0].elapsedMs >= 4900 && requests[0].elapsedMs < 9500)
  assert.ok(log.every(entry => !JSON.stringify(entry).includes('fixture')))
})

test('permanent HTTP and network failures do not retry', async t => {
  for (const [status, code] of [[400, 'KRX_INVALID_REQUEST'], [401, 'KRX_AUTH_REJECTED'],
    [403, 'KRX_ACCESS_DENIED'], [null, 'PROVIDER_UNAVAILABLE']]) {
    const root = await mkdtemp(join(tmpdir(), 'krx-permanent-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    const requests = []
    const provider = createKrxProvider({ root, key: 'fixture', log: entry => requests.push(entry),
      clock: () => Date.parse('2026-11-23T08:31:00Z'),
      fetchImpl() {
        if (status === null) throw new TypeError('fetch failed', { cause: { code: 'CERT_HAS_EXPIRED' } })
        return new Response(null, { status })
      },
    })
    assert.equal((await provider.indices('KOSPI')).errorCode, code)
    assert.deepEqual(requests.filter(entry => entry.event === 'krx-request').map(entry => entry.httpStatus), [status])
  }
})


test('HTTP 200 body connection failures retry at most twice', async t => {
  for (const [networkCode, recover] of [['ECONNRESET', true], ['UND_ERR_SOCKET', false]]) {
    await t.test(networkCode, async t => {
      const root = await mkdtemp(join(tmpdir(), 'krx-body-connection-'))
      t.after(() => rm(root, { recursive: true, force: true }))
      const log = []
      let calls = 0
      const provider = createKrxProvider({ root, key: 'fixture', log: entry => log.push(entry),
        clock: () => Date.parse('2026-11-23T08:31:00Z'),
        fetchImpl() {
          calls++
          if (recover && calls === 3) {
            return response([{ IDX_CLSS: 'KOSPI', IDX_NM: '코스피', BAS_DD: '20261123', CLSPRC_IDX: '105' }])
          }
          const error = networkCode === 'ECONNRESET'
            ? Object.assign(new Error('upstream disconnect'), { code: networkCode })
            : new TypeError('terminated', { cause: { code: networkCode } })
          return new Response(new ReadableStream({
            start(controller) { controller.enqueue(new TextEncoder().encode('{"OutBlock_1":')) },
            pull(controller) { controller.error(error) },
          }))
        },
      })
      const result = await provider.indices('KOSPI')
      assert.equal(calls, 3)
      assert.equal(recover ? result.price : result.errorCode, recover ? 105 : 'PROVIDER_CONNECTION_ERROR')
      assert.deepEqual(log.filter(entry => entry.event === 'krx-request')
        .map(({ attempt, httpStatus, code }) => [attempt, httpStatus, code]), [
        [1, 200, 'PROVIDER_CONNECTION_ERROR'], [2, 200, 'PROVIDER_CONNECTION_ERROR'],
        [3, 200, recover ? null : 'PROVIDER_CONNECTION_ERROR'],
      ])
    })
  }
})

test('malformed, oversized, and unclassified bodies and HTTP 429 do not retry', async t => {
  for (const [createResponse, status, code] of [
    [() => new Response('{'), 200, 'PROVIDER_INVALID_JSON'],
    [() => new Response(new Uint8Array(4 * 1024 * 1024 + 1)), 200, 'PROVIDER_RESPONSE_TOO_LARGE'],
    [() => new Response(new ReadableStream({ pull(controller) { controller.error(new Error('unknown body error')) } })),
      200, 'PROVIDER_BODY_ERROR'],
    [() => new Response(null, { status: 429 }), 429, 'PROVIDER_RATE_LIMITED'],
  ]) {
    await t.test(code, async t => {
      const root = await mkdtemp(join(tmpdir(), 'krx-no-body-retry-'))
      t.after(() => rm(root, { recursive: true, force: true }))
      const log = []
      let calls = 0
      const provider = createKrxProvider({ root, key: 'fixture', log: entry => log.push(entry),
        clock: () => Date.parse('2026-11-23T08:31:00Z'),
        fetchImpl() { calls++; return createResponse() },
      })
      assert.equal((await provider.indices('KOSPI')).errorCode, code)
      assert.equal(calls, 1)
      assert.deepEqual(log.filter(entry => entry.event === 'krx-request')
        .map(({ httpStatus, code }) => [httpStatus, code]), [[status, code]])
    })
  }
})
