import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, rmdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { configureMemberKrx as configureMember, createKrxProvider as createProvider } from './krx-provider.mjs'
import { createKrxCalendar, krxCollectionSession } from './krx-calendar-provider.mjs'
import { createIndexSnapshot } from './market-index-provider.mjs'
import { buildApp, registerKrxCollector } from './server.mjs'

const createKrxProvider = options => createProvider({ retryDelays: [0, 0], ...options })
const configureMemberKrx = options => configureMember({ retryDelays: [0, 0], ...options })

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
  let now = Date.parse('2026-11-23T12:15:00Z')
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
  now = Date.parse('2026-11-24T01:10:00Z')
  await provider.collect()
  const list = await provider.stocks({ market: 'KOSDAQ', symbol })
  const detail = await provider.stockHistory(symbol)
  assert.equal(list.listingDate, oldDate)
  assert.equal(list.trades.tradingDate, newDate)
  assert.equal(list.trades.collectedAt, detail.collectedAt)
  assert.deepEqual(list.items[0].quote, detail.quote)
  assert.equal(detail.latestDate, newDate)
  assert.equal(detail.reason, 'before-collection')
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
    enabled: '1', key: 'fixture', root, clock: () => Date.parse('2026-11-20T12:15:00Z'),
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
  assert.equal(overview.leaders.advances[0].name, '삼성전자')
  assert.equal(overview.leaders.advances[0].fullName, '삼성전자보통주')
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

test('overview, search, detail and watchlist use the same KRX master name for each code', async t => {
  const root = await mkdtemp(join(tmpdir(), 'krx-display-names-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const securities = [
    { symbol: '004545', name: '깨끗한나라우', fullName: '깨끗한나라1우선주', shareClass: '우선주', market: 'KOSPI' },
    { symbol: '009140', name: '케이아이아이', fullName: '케이아이아이보통주', shareClass: '보통주', market: 'KOSPI' },
    { symbol: '004540', name: '깨끗한나라', fullName: '깨끗한나라보통주', shareClass: '보통주', market: 'KOSPI' },
    { symbol: '263860', name: '지니언스', fullName: '지니언스보통주', shareClass: '보통주', market: 'KOSDAQ' },
  ]
  const krx = createKrxProvider({
    root, key: 'fixture', log: () => {}, clock: () => Date.parse('2026-11-21T08:00:00Z'),
    fetchImpl(url) {
      const market = url.pathname.includes('stk_') ? 'KOSPI' : 'KOSDAQ'
      const rows = securities.filter(stock => stock.market === market)
      if (url.pathname.endsWith('base_info')) return response(rows.map(stock => ({
        ISU_SRT_CD: stock.symbol, ISU_ABBRV: stock.name, ISU_NM: stock.fullName,
        KIND_STKCERT_TP_NM: stock.shareClass, LIST_DD: '20261120', MKT_TP_NM: market,
      })))
      return response(rows.map((stock, index) => ({
        BAS_DD: url.searchParams.get('basDd'), ISU_CD: stock.symbol, ISU_NM: stock.fullName, MKT_NM: market,
        TDD_CLSPRC: String(105 + index), TDD_OPNPRC: '100', TDD_HGPRC: '110', TDD_LWPRC: '99',
        CMPPREVDD_PRC: '5', ACC_TRDVOL: '1234', MKTCAP: '5000', FLUC_RT: '5',
      })))
    },
  })
  const app = await buildApp({ logger: false, localKrx: krx, membership: {
    verify: () => ({ id: 'display-name-test' }), read: () => ({ status: 'approved' }),
  } })
  t.after(() => app.close())
  const headers = { host: '127.0.0.1', authorization: 'Bearer test.good.token' }
  const request = async (url, payload) => {
    const result = await app.inject({ method: payload ? 'POST' : 'GET', url, headers, payload })
    assert.equal(result.statusCode, 200, url)
    return result.json()
  }
  const overview = await request('/api/v1/market/kr/overview')
  const watchlist = await request('/api/v1/market/watchlist/observations', {
    items: securities.map(({ symbol }) => ({ market: 'KR', exchange: 'XKRX', symbol })),
  })
  for (const { symbol, name, fullName, shareClass, market } of securities) {
    const history = await request('/api/v1/market/kr/stocks/' + symbol + '/history')
    const byCode = await request('/api/v1/market/kr/stocks?market=' + market + '&symbol=' + symbol)
    const byName = await request('/api/v1/market/kr/stocks?market=' + market + '&q=' + encodeURIComponent(fullName))
    const mover = overview.leaders.advances.find(row => row.symbol === symbol)
    const saved = watchlist.items.find(row => row.listing.symbol === symbol)
    assert.deepEqual([history.name, byCode.items[0].name, byName.items[0].name, mover.name, mover.shortName, saved.name],
      Array(6).fill(name), symbol)
    assert.deepEqual([history.symbol, byCode.items[0].symbol, byName.items[0].symbol, mover.symbol, saved.listing.symbol],
      Array(5).fill(symbol))
    assert.deepEqual([history.market, byCode.items[0].market, mover.market, saved.segment], Array(4).fill(market))
    assert.deepEqual([history.fullName, history.quote.name, byCode.items[0].fullName, mover.fullName, mover.rawName],
      Array(5).fill(fullName))
    assert.deepEqual([history.shareClass, byCode.items[0].shareClass, mover.shareClass], Array(3).fill(shareClass))
    assert.deepEqual(overview.marketTiles[market].find(row => row.symbol === symbol), mover)
    for (const quote of [byCode.items[0].quote, saved.quote, mover]) {
      for (const key of ['price', 'changePercent', 'volume']) assert.equal(quote[key], history.quote[key])
    }
    assert.equal(history.history.bars.at(-1).close, history.quote.price)
  }
})

test('backfill stops on HTTP 429 and a rerun skips the saved latest session', async t => {
  const root = await mkdtemp(join(tmpdir(), 'krx-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  let now = Date.parse('2026-11-21T08:00:00Z')
  const clock = () => now
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
  await assert.rejects(createKrxProvider({ key: 'fixture', root, clock, fetchImpl: get(null) }).backfill(1),
    { code: 'PROVIDER_RATE_LIMITED' })
  now += 30 * 60_000
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
  let now = Date.parse('2026-11-20T12:15:00Z')
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
  now = Date.parse('2026-11-23T12:14:00Z')
  assert.equal((await member.stockHistory('005930')).history.bars[0].tradingDate, '2026-11-20')
  assert.equal(calls.length, 6)
  now = Date.parse('2026-11-23T12:15:00Z')
  await Promise.all([member.collect(), member.collect()])
  assert.equal(calls.length, 12)
  let stock = await member.stockHistory('005930')
  assert.equal(stock.reason, 'not-published')
  assert.equal(stock.quote.price, 100)
  member = configureMemberKrx(opts)
  await member.collect()
  assert.equal(calls.length, 12)
  published = true
  now = Date.parse('2026-11-24T01:10:00Z')
  await member.collect()
  stock = await member.stockHistory('005930')
  assert.equal(stock.quote.price, 102)
  assert.equal(stock.collectedAt, '2026-11-24T01:10:00.000Z')
  assert.deepEqual(stock.history.bars.map(bar => bar.tradingDate), ['2026-11-20', '2026-11-23'])
  assert.ok(stock.afterHours.every(row => row.price === null && row.eligibility === 'unknown' && row.connectionCheckedAt === null))
  now = Date.parse('2026-11-24T11:15:00Z')
  await member.collect()
  stock = await member.stockHistory('005930')
  assert.deepEqual(stock.afterHours.map(row => row.venue), ['KRX', 'NXT'])
  assert.ok(stock.afterHours.every(row => row.status === 'provider-unavailable' &&
    row.price === null && row.connectionCheckedAt === '2026-11-24T11:15:00.000Z'))
  assert.equal(calls.filter(([date, path]) => date === '20261123' && path.endsWith('/stk_bydd_trd')).length, 2)
})

test('scheduled rate limiting stops other endpoints until the next allowed window', async t => {
  const root = await mkdtemp(join(tmpdir(), 'krx-rate-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  let now = Date.parse('2026-11-23T12:15:00Z')
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
  now = Date.parse('2026-11-23T12:46:00Z')
  member = configureMemberKrx(options)
  await member.collect()
  assert.equal(calls, 2)
  now = Date.parse('2026-11-24T01:10:00Z')
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
  assert.equal(at('2026-11-22T23:09Z').canCollect, false)
  assert.equal(at('2026-11-22T23:10Z').canCollect, true)
  assert.equal(at('2026-11-23T01:10Z').date, '2026-11-20')
  assert.equal(at('2026-09-28T01:10Z').date, '2026-09-23')
  assert.equal(at('2026-11-23T12:15Z').date, '2026-11-23')
  assert.equal(at('2026-11-19T12:14Z').date, '2026-11-18')
  assert.equal(at('2026-11-19T12:15Z').date, '2026-11-19')
  assert.equal(at('2027-01-06T08:00Z').canCollect, false)
  const override = createKrxCalendar('{"years":[2027],"closed":["2027-01-07"],"regularClose":{"2027-01-06":"21:30"},"afterClose":{"2027-01-06":"20:30"}}')
  assert.equal(krxCollectionSession(Date.parse('2027-01-06T07:00Z'), override).afterCheckAt, '2027-01-06T11:45:00.000Z')
  assert.equal(krxCollectionSession(Date.parse('2027-01-06T12:59Z'), override).date, '2027-01-05')
  assert.equal(krxCollectionSession(Date.parse('2027-01-06T13:00Z'), override).date, '2027-01-06')
  assert.equal(krxCollectionSession(Date.parse('2027-01-07T07:00Z'), override).canCollect, false)
  assert.equal(krxCollectionSession(Date.parse('2027-01-08T01:10Z'), override).date, '2027-01-06')
})

test('scheduled OHLCV persistence failure retains the last successful close', async t => {
  const root = await mkdtemp(join(tmpdir(), 'krx-write-failure-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  let now = Date.parse('2026-11-20T12:15:00Z')
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
  now = Date.parse('2026-11-23T12:15:00Z')
  await member.collect()
  const fallback = await member.stockHistory('005930')
  assert.equal(fallback.reason, 'provider-error')
  assert.equal(fallback.quote.price, 100)
  assert.equal(fallback.latestDate, '2026-11-20')
  assert.deepEqual(fallback.history.bars.map(bar => bar.tradingDate), ['2026-11-20'])
  await member.collect()
  assert.deepEqual(fetched, ['20261120', '20261123'])
  await rmdir(blocked)
  now = Date.parse('2026-11-24T01:10:00Z')
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
  const provider = createKrxProvider({ root, key: 'fixture', timeouts: { index: 100 }, log: entry => log.push(entry),
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
  assert.equal(requests[0].timeoutMs, 100)
  assert.ok(requests[0].timings.bodyMs >= 80)
  assert.equal(requests[0].timings.jsonMs, null)
  assert.equal(typeof requests[2].timings.jsonMs, 'number')
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

function recoveryFixture(url) {
  const date = url.searchParams.get('basDd')
  const path = url.pathname
  const kosdaq = /ksq_|kosdaq/.test(path)
  const market = kosdaq ? 'KOSDAQ' : 'KOSPI'
  const symbol = kosdaq ? '263860' : '005930'
  if (path.includes('/idx/')) return response([
    { IDX_CLSS: market, IDX_NM: kosdaq ? '코스닥' : '코스피', BAS_DD: date, CLSPRC_IDX: '105' },
  ])
  if (path.endsWith('_base_info')) return response([
    { LIST_DD: '20261120', MKT_TP_NM: market, ISU_ABBRV: symbol, ISU_SRT_CD: symbol, ISU_CD: market === 'KOSPI' ? 'KR7005930003' : 'KR7263860000' },
  ])
  return response([{ BAS_DD: date, MKT_NM: market, ISU_CD: symbol, ISU_NM: symbol,
    TDD_CLSPRC: '105', TDD_OPNPRC: '100', TDD_HGPRC: '110', TDD_LWPRC: '99',
    ACC_TRDVOL: '20', ACC_TRDVAL: '2100', MKTCAP: '1000', FLUC_RT: '1' }])
}

test('automatic recovery fills the November 23 gap after November 24 is current', async t => {
  const root = await mkdtemp(join(tmpdir(), 'krx-auto-recovery-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  let now = Date.parse('2026-11-20T12:15Z')
  let recovery = false
  const calls = []
  const options = { root, key: 'fixture', scheduledOnly: true, clock: () => now, log: () => {},
    fetchImpl(url) {
      const date = url.searchParams.get('basDd')
      calls.push([date, url.pathname.split('/').at(-1)])
      if (date === '20261123' && !recovery) {
        if (!url.pathname.endsWith('/kospi_dd_trd')) return response([])
      }
      return recoveryFixture(url)
    } }
  let provider = createKrxProvider(options)
  await provider.collect()
  const old = join(root, 'ohlcv-KOSPI-2026-11-20.json')
  const original = await readFile(old, 'utf8')
  now = Date.parse('2026-11-23T12:15Z')
  await provider.collect()
  now = Date.parse('2026-11-24T12:15Z')
  await provider.collect()
  assert.equal((await provider.stockHistory('005930')).stoppedAt, '2026-11-23')
  const historicalPlan = await provider.backfillMissingDates({ dates: ['2026-11-23', '2026-11-24', '2026-11-22'] })
  assert.deepEqual(historicalPlan.deferredDates, ['2026-11-24', '2026-11-22'])
  assert.equal(historicalPlan.targets.length, 3)
  now = Date.parse('2026-11-25T01:10Z')
  recovery = true
  const count = calls.length
  provider = createKrxProvider(options)
  await Promise.all([provider.collect(), createKrxProvider(options).collect()])
  assert.deepEqual(new Set(calls.slice(count).map(([, path]) => path)),
    new Set(['stk_bydd_trd', 'ksq_bydd_trd', 'kosdaq_dd_trd']))
  assert.equal(calls.length - count, 3)
  await createKrxProvider(options).collect()
  assert.equal(calls.length - count, 3)
  assert.equal(await readFile(old, 'utf8'), original)
  for (const [market, symbol] of [['KOSPI', '005930'], ['KOSDAQ', '263860']]) {
    assert.equal((await provider.indices(market)).tradingDate, '2026-11-24')
    assert.deepEqual((await provider.stockHistory(symbol)).history.bars.map(bar => bar.tradingDate),
      ['2026-11-20', '2026-11-23', '2026-11-24'])
  }
  const overview = await provider.overview()
  assert.equal(overview.tradingDate, '2026-11-24')
  assert.equal(overview.leaders.advances.length, 2)
  assert.equal(overview.leaders.volume.length, 2)
  assert.equal(overview.leaders.turnover[0].turnover, 2100)
  assert.equal(overview.tiles.length, 2)
  assert.equal((await provider.backfillMissingDates({ dates: ['2026-11-23', '2026-11-24'] })).maxRequests, 0)
})

test('selective recovery plans two consecutive gaps and repairs only the selected datasets', async t => {
  const root = await mkdtemp(join(tmpdir(), 'krx-selective-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  let now = Date.parse('2026-11-25T01:10Z')
  const calls = []
  const options = { root, key: 'fixture', scheduledOnly: true, clock: () => now, log: () => {},
    fetchImpl(url) {
      calls.push(url.pathname)
      if (calls.length === 1) throw new TypeError('socket', { cause: { code: 'ECONNRESET' } })
      return recoveryFixture(url)
    } }
  const provider = createKrxProvider(options)
  const selector = { dates: ['2026-11-23', '2026-11-24'], markets: ['KOSPI'], kinds: ['trades'] }
  const plan = await provider.backfillMissingDates(selector)
  assert.equal(plan.maxRequests, 2)
  assert.equal(calls.length, 0)
  const run = await provider.backfillMissingDates({ ...selector, dryRun: false })
  assert.equal(run.attempts, 2)
  assert.deepEqual(run.outcomes.map(item => item.status), ['error', 'available'])
  assert.equal((await provider.stocks({ market: 'KOSPI' })).trades.tradingDate, null)
  const otherMarket = await provider.backfillMissingDates({ ...selector, markets: ['KOSDAQ'], dates: ['2026-11-24'] })
  assert.equal(otherMarket.targets.length, 1)
  assert.equal((await provider.backfillMissingDates(selector)).targets[0].status, 'retry-pending')
  await provider.collect()
  assert.equal((await provider.stocks({ market: 'KOSPI' })).trades.tradingDate, '2026-11-24')
  assert.equal(calls.filter(path => path.endsWith('/stk_bydd_trd')).length, 2)
  now += 24 * 3_600_000
  const resumed = await provider.backfillMissingDates({ ...selector, dryRun: false })
  assert.equal(resumed.attempts, 1)
  assert.equal(resumed.outcomes[0].date, '2026-11-23')
  assert.equal((await provider.backfillMissingDates(selector)).maxRequests, 0)
})

test('selective recovery shares its request budget, lock and cooldown with scheduled collection', async t => {
  const root = await mkdtemp(join(tmpdir(), 'krx-recovery-budget-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  let now = Date.parse('2026-11-25T01:10Z')
  let release, dispatch
  const queued = new Promise(resolve => { dispatch = resolve })
  const inbound = new Promise(resolve => { release = resolve })
  const ledger = join(root, 'krx-request-budget.json')
  await writeFile(ledger, JSON.stringify({ requests: Array(299).fill(now - 60_000), blockedUntil: 0, lastDispatch: 0 }))
  let calls = 0
  const options = { root, key: 'fixture', scheduledOnly: true, clock: () => now, log: () => {},
    async fetchImpl() {
      calls++
      dispatch()
      await inbound
      return new Response(null, { status: 429, headers: { 'retry-after': '3600' } })
    } }
  const selector = { dates: ['2026-11-23'], kinds: ['index'], dryRun: false }
  const running = createKrxProvider(options).backfillMissingDates(selector)
  await queued
  try {
    await assert.rejects(createKrxProvider(options).backfillMissingDates(selector), { code: 'KRX_BACKFILL_BUSY' })
    await createKrxProvider(options).collect()
    assert.equal(calls, 1)
  } finally {
    release()
  }
  const result = await running
  assert.equal(result.stopped, 'PROVIDER_RATE_LIMITED')
  assert.equal(result.attempts, 1)
  const planned = await createKrxProvider(options).backfillMissingDates({ ...selector, dryRun: true })
  assert.equal(planned.remainingRequests, 0)
  assert.equal(planned.cooldownUntil, '2026-11-25T02:10:00.000Z')
  now += 61 * 60_000
  await createKrxProvider(options).collect()
  assert.equal(calls, 1)
})

test('selective recovery preserves readable snapshots and stops on write or auth failure', async t => {
  for (const mode of ['write', 'auth']) {
    await t.test(mode, async t => {
      const root = await mkdtemp(join(tmpdir(), 'krx-recovery-failure-'))
      t.after(() => rm(root, { recursive: true, force: true }))
      const badDate = join(root, 'ohlcv-KOSPI-2026-11-23.json')
      if (mode === 'write') await mkdir(badDate)
      const latest = join(root, 'sto-stk_bydd_trd.json')
      const snapshot = JSON.stringify({ version: 1, history: [], data: { date: '2026-11-24', rows: [
        { symbol: '005930', tradingDate: '2026-11-24', price: 105, open: 101, high: 110, low: 99, volume: 20 },
      ] } })
      await writeFile(latest, snapshot)
      let calls = 0
      const provider = createKrxProvider({ root, key: 'fixture', scheduledOnly: true, log: () => {},
        clock: () => Date.parse('2026-11-25T01:10Z'), fetchImpl(url) {
          calls++
          return mode === 'auth' ? new Response(null, { status: 401 }) : recoveryFixture(url)
        } })
      const result = await provider.backfillMissingDates({ dates: ['2026-11-23'], kinds: ['trades'], dryRun: false })
      assert.equal(result.stopped, mode === 'auth' ? 'KRX_AUTH_REJECTED' : 'KRX_HISTORY_CACHE_FAILED')
      assert.equal(calls, 1)
      assert.equal(await readFile(latest, 'utf8'), snapshot)
    })
  }
})

test('a partial publish keeps both markets on the last common date and reports the last attempt', async t => {
  const root = await mkdtemp(join(tmpdir(), 'krx-common-close-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  let now = Date.parse('2026-11-20T12:15Z')
  const provider = createKrxProvider({ root, key: 'fixture', scheduledOnly: true, log: () => {}, clock: () => now,
    fetchImpl(url) {
      if (url.searchParams.get('basDd') === '20261123') {
        if (url.pathname.endsWith('/ksq_bydd_trd')) return response([])
        if (url.pathname.endsWith('/ksq_isu_base_info')) return response([
          { LIST_DD: '20261120', MKT_TP_NM: 'KOSDAQ', ISU_ABBRV: '변경된 종목명', ISU_SRT_CD: '263860', ISU_CD: 'KR7263860000' },
        ])
      }
      return recoveryFixture(url)
    } })
  await provider.collect()
  now = Date.parse('2026-11-23T12:15Z')
  await provider.collect()
  const stocks = await provider.stocks({ market: 'KOSDAQ', symbols: ['263860'] })
  assert.equal(stocks.items[0].quote.tradingDate, '2026-11-20')
  assert.equal(stocks.trades.status, 'stale')
  assert.equal(stocks.trades.reason, 'not-published')
  assert.equal(stocks.trades.lastAttemptAt, '2026-11-23T12:15:00.000Z')
  assert.equal(stocks.trades.usingPreviousClose, true)
  const overview = await provider.overview()
  assert.equal(overview.tradingDate, '2026-11-20')
  assert.equal(overview.usingPreviousClose, true)
  assert.equal(overview.leaders.volume.length, 2)
  assert.equal(stocks.listingDate, '2026-11-23')
  const renamed = overview.leaders.volume.find(row => row.symbol === '263860')
  assert.equal(renamed.name, '변경된 종목명')
  assert.equal(renamed.rawName, '263860')
  assert.equal(renamed.name, stocks.items[0].name)
  assert.equal(renamed.name, (await provider.stockHistory('263860')).name)
})

test('HTTP failures and a malformed observation never publish index data', async t => {
  const root = await mkdtemp(join(tmpdir(), 'krx-http-errors-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const failures = [500, 502, 504]
  let now = Date.parse('2026-11-23T12:15Z')
  const log = []
  const provider = createKrxProvider({ root, key: 'fixture', clock: () => now, log: entry => log.push(entry),
    fetchImpl() {
      return failures.length ? new Response(null, { status: failures.shift() }) : response([
        { IDX_CLSS: 'KOSPI', IDX_NM: '코스피', BAS_DD: '20261124', CLSPRC_IDX: 'invalid' },
      ])
    } })
  assert.equal((await provider.indices('KOSPI')).errorCode, 'PROVIDER_UNAVAILABLE')
  now = Date.parse('2026-11-24T12:15Z')
  assert.equal((await provider.indices('KOSPI')).errorCode, 'KRX_INVALID_OBSERVATIONS')
  assert.deepEqual(log.filter(entry => entry.event === 'krx-request').map(entry => entry.httpStatus), [500, 502, 504, 200])
})

test('uneven KRX snapshots preserve names without joining a new listing to a reused code', async t => {
  const root = await mkdtemp(join(tmpdir(), 'krx-uneven-names-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const tradeDate = '2026-11-24'
  const listingDate = '2026-11-25'
  const snapshot = (date, rows) => ({ version: 1, history: [], data: { date, collectedAt: date + 'T10:00:00Z', rows } })
  const trade = (market, symbol, name) => ({ market, symbol, name, tradingDate: tradeDate,
    price: 100, volume: 20, turnover: 2000, marketCap: 1000, changePercent: 1 })
  const issue = (market, symbol, name, listedOn = '2020-01-01') => ({ market, symbol, name, fullName: name, listedOn })
  await Promise.all([
    writeFile(join(root, 'sto-stk_bydd_trd.json'), JSON.stringify(snapshot(tradeDate, [
      trade('KOSPI', '005930', '삼성전자'), trade('KOSPI', '000123', '이전 회사'),
    ]))),
    writeFile(join(root, 'sto-ksq_bydd_trd.json'), JSON.stringify(snapshot(tradeDate, [
      trade('KOSDAQ', '005930', '코스닥 회사'), trade('KOSDAQ', '263860', '상장폐지 종목'),
    ]))),
    writeFile(join(root, 'sto-stk_isu_base_info.json'), JSON.stringify(snapshot(listingDate, [
      issue('KOSPI', '005930', '삼성전자'), issue('KOSPI', '000123', '신규 회사', listingDate),
    ]))),
    writeFile(join(root, 'sto-ksq_isu_base_info.json'), JSON.stringify(snapshot('2026-11-23', [
      issue('KOSDAQ', '005930', '코스닥 회사'),
    ]))),
  ])
  const log = []
  const provider = createKrxProvider({ root, key: 'fixture', scheduledOnly: true,
    clock: () => Date.parse('2026-11-26T00:00Z'), log: entry => log.push(entry),
    fetchImpl: () => assert.fail('cache reads must never call KRX') })
  const overview = await provider.overview()
  assert.equal(overview.tradingDate, tradeDate)
  assert.deepEqual(overview.marketTiles.KOSPI.map(row => [row.symbol, row.name, row.mapped]),
    [['000123', '이전 회사', false], ['005930', '삼성전자', true]])
  assert.deepEqual(overview.marketTiles.KOSDAQ.map(row => [row.name, row.mapped]),
    [['코스닥 회사', true], ['상장폐지 종목', false]])
  const listing = await provider.stocks({ market: 'KOSPI', symbol: '000123' })
  assert.equal(listing.items[0].quote, null)
  await provider.overview()
  assert.deepEqual(log.map(({ mapped, failed, mappingRate, codeOnly }) => [mapped, failed, mappingRate, codeOnly]),
    [[1, 1, 0.5, 0], [1, 1, 0.5, 0]])
})

test('timeouts, empty or partially invalid masters preserve the last good cache independently', async t => {
  const root = await mkdtemp(join(tmpdir(), 'krx-incomplete-master-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  let now = Date.parse('2026-11-24T12:15Z')
  const master = { LIST_DD: '19750611', MKT_TP_NM: 'KOSPI', ISU_ABBRV: '삼성전자',
    ISU_NM: '삼성전자보통주', ISU_SRT_CD: '5930', ISU_CD: 'KR7005930003' }
  const log = []
  const provider = createKrxProvider({ root, key: 'fixture', scheduledOnly: true,
    clock: () => now, timeouts: { trades: 40 }, log: entry => log.push(entry),
    async fetchImpl(url, { signal }) {
      const date = url.searchParams.get('basDd')
      if (url.pathname.endsWith('/stk_isu_base_info')) {
        if (date === '20261125') return response([master, { ...master, ISU_SRT_CD: '000660', ISU_ABBRV: '' }])
        if (date === '20261126') return response([])
        return response([master])
      }
      if (date !== '20261124' && url.pathname.endsWith('/stk_bydd_trd')) await delay(100, undefined, { signal })
      if (url.pathname.endsWith('/stk_bydd_trd')) return response([{ BAS_DD: date, MKT_NM: 'KOSPI',
        ISU_CD: '005930', ISU_NM: '삼성전자', TDD_CLSPRC: '100', TDD_OPNPRC: '100',
        TDD_HGPRC: '101', TDD_LWPRC: '99', ACC_TRDVOL: '20' }])
      return recoveryFixture(url)
    },
  })
  await provider.collect()
  for (const date of ['2026-11-25', '2026-11-26']) {
    now = Date.parse(date + 'T12:15Z')
    await provider.collect()
    const stocks = await provider.stocks({ market: 'KOSPI', symbol: '005930' })
    assert.equal(stocks.listingDate, '2026-11-24')
    assert.equal(stocks.items[0].name, '삼성전자')
    assert.equal(stocks.trades.tradingDate, '2026-11-24')
    assert.equal(stocks.trades.collectedAt, '2026-11-24T12:15:00.000Z')
    assert.equal(stocks.trades.lastAttemptAt, date + 'T12:15:00.000Z')
    assert.equal((await provider.indices('KOSDAQ')).tradingDate, date)
  }
  assert.equal(log.filter(row => row.event === 'krx-request' && row.code === 'PROVIDER_TIMEOUT').length, 6)
  assert.ok(log.some(row => row.event === 'krx-request' && row.code === 'KRX_INCOMPLETE_MASTER'))
})

test('official and trade names remain searchable without joining a reused symbol to older prices', async t => {
  const root = await mkdtemp(join(tmpdir(), 'krx-name-priority-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const date = '2026-11-24'
  const prior = '2026-11-23'
  const snapshot = (day, rows) => ({ date: day, collectedAt: day + 'T10:00:00Z', rows })
  const cache = (file, data, previousData) =>
    writeFile(join(root, file + '.json'), JSON.stringify({ version: 1, history: [], data, previousData }))
  const issue = (market, symbol, name, fullName, isin, listedOn = '2020-01-01') =>
    ({ market, symbol, name, fullName, listedOn, isin, englishName: '', shareClass: '보통주' })
  const quote = (market, symbol, name) => ({ market, symbol, name, tradingDate: date, price: 100,
    open: 100, high: 101, low: 99, volume: 20, changePercent: 0, marketCap: 5000 })
  await Promise.all([
    cache('sto-stk_isu_base_info', snapshot(date, [issue('KOSPI', '005930', '공식 약명', '공식 정식명칭', 'KR7005930003')])),
    cache('sto-stk_bydd_trd', snapshot(date, [quote('KOSPI', '005930', '상이한 거래명')])),
    cache('sto-ksq_isu_base_info', snapshot('2026-11-25', [
      issue('KOSDAQ', '000123', '새 약명', '새 정식명칭', 'KR7000120001'),
      issue('KOSDAQ', '000124', '동일 이름', '새 회사', 'KR7000124009', '2026-11-25'),
    ]), snapshot(prior, [
      issue('KOSDAQ', '000123', '이전 약명', '이전 정식명칭', 'KR7000120001'),
      issue('KOSDAQ', '000124', '동일 이름', '이전 회사', 'KR7000124001'),
    ])),
    cache('sto-ksq_bydd_trd', snapshot(date, [
      quote('KOSDAQ', '000123', '이전 정식명칭'), quote('KOSDAQ', '000124', '이전 회사'),
      quote('KOSDAQ', '000125', '거래 응답 이름'), quote('KOSDAQ', '000126', ''),
    ])),
  ])
  const log = []
  const provider = createKrxProvider({ root, key: 'fixture', scheduledOnly: true,
    log: entry => log.push(entry), clock: () => Date.parse('2026-11-26T00:00Z') })
  const overview = await provider.overview()
  assert.equal(overview.marketTiles.KOSPI[0].shortName, '공식 약명')
  assert.equal(log.find(row => row.market === 'KOSPI').sameDateNameConflicts, 1)
  assert.deepEqual(overview.marketTiles.KOSDAQ.map(({ shortName }) => shortName),
    ['새 약명', '동일 이름', '거래 응답 이름', '000126'])
  for (const q of ['공식 약명', '정식명칭', '005930']) {
    assert.equal((await provider.stocks({ market: 'KOSPI', q })).items[0].name, '공식 약명')
  }
  const renamed = (await provider.stocks({ market: 'KOSDAQ', symbol: '000123' })).items[0]
  assert.equal(renamed.name, '새 약명')
  assert.equal(renamed.quote.tradingDate, date)
  const reused = (await provider.stocks({ market: 'KOSDAQ', symbol: '000124' })).items[0]
  assert.equal(reused.fullName, '새 회사')
  assert.equal(reused.quote, null)
  assert.equal((await provider.stockHistory('000124')).history.bars.length, 0)
  const fallback = (await provider.stocks({ market: 'KOSDAQ', q: '거래 응답 이름' })).items[0]
  assert.equal(fallback.listedOn, null)
  assert.equal(fallback.symbol, '000125')
  const detail = await provider.stockHistory('000125')
  assert.equal(detail.name, fallback.name)
  assert.deepEqual(detail.history.bars.map(bar => bar.tradingDate), [date])
  const app = await buildApp({ logger: false, memberKrx: provider, membership: {
    verify: () => ({ id: 'display-name-test' }), read: () => ({ status: 'approved' }),
  } })
  t.after(() => app.close())
  const saved = await app.inject({ method: 'POST', url: '/api/v1/market/watchlist/observations',
    headers: { authorization: 'Bearer test.good.token' },
    payload: { items: ['000125', '000126'].map(symbol => ({ market: 'KR', exchange: 'XKRX', symbol })) } })
  assert.equal(saved.statusCode, 200)
  assert.deepEqual(saved.json().items.map(item => item.name), ['거래 응답 이름', '000126'])
})
