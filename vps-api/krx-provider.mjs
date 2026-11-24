import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import { isDay, providerClient, ProviderError } from './public-provider.mjs'

const source = 'KRX OPEN API'
const endpoint = {
  KOSPI: { index: 'idx/kospi_dd_trd', trades: 'sto/stk_bydd_trd', listings: 'sto/stk_isu_base_info', name: '코스피' },
  KOSDAQ: { index: 'idx/kosdaq_dd_trd', trades: 'sto/ksq_bydd_trd', listings: 'sto/ksq_isu_base_info', name: '코스닥' },
}
const services = Object.values(endpoint).flatMap(({ index, trades, listings }) => [index, trades, listings])
const minutes = [16 * 60 + 30, 17 * 60 + 30, 19 * 60, 21 * 60, 23 * 60]
const dayMs = 86_400_000
const koreanOffset = 9 * 60 * 60_000
const day = timestamp => new Date(timestamp).toISOString().slice(0, 10)
const isoDay = value => typeof value === 'string' ? value.replace(/^(\d{4})(\d\d)(\d\d)$/, '$1-$2-$3') : ''
const codePattern = /^[0-9A-Z]{6}$/
const weekend = date => [0, 6].includes(new Date(date).getUTCDay())
const historyDays = 780
const historySessions = 500
const firstOfficialDate = '2010-01-04'
const markets = Object.keys(endpoint)
const backfillStopCodes = new Set(['PROVIDER_RATE_LIMITED', 'KRX_BACKFILL_BUDGET', 'KRX_AUTH_REJECTED',
  'KRX_ACCESS_DENIED', 'KRX_HISTORY_CACHE_FAILED'])
const retryableHttp = new Set([408, 500, 502, 503, 504])

function * tradingCandidates(date) {
  for (let offset = 0; offset < historyDays; offset++) {
    const candidate = day(Date.parse(date) - offset * dayMs)
    if (candidate < firstOfficialDate) break
    if (!weekend(candidate)) yield candidate
  }
}

function toBar(row) {
  if (![row.open, row.high, row.low, row.price, row.volume].every(Number.isFinite)
    || row.low <= 0 || row.low > Math.min(row.open, row.price)
    || row.high < Math.max(row.open, row.price) || row.volume <= 0) return null
  return [row.symbol, row.open, row.high, row.low, row.price, row.volume]
}

function session(time) {
  const local = time + koreanOffset
  const today = day(local)
  const nowMinutes = Math.floor((local % dayMs) / 60_000)
  const slot = minutes.findLastIndex(minute => nowMinutes >= minute)
  if (!weekend(today) && slot !== -1) return { date: today, slot, weekend: false, beforeClose: false }
  let prior = Date.parse(today) - dayMs
  while (weekend(prior)) prior -= dayMs
  const overnightSlot = prior === Date.parse(today) - dayMs && nowMinutes >= 6 * 60
  return { date: day(prior), slot: overnightSlot ? minutes.length : minutes.length - 1,
    weekend: weekend(today), beforeClose: !weekend(today) }
}

function value(raw) {
  if (typeof raw !== 'string') return null
  const text = raw.trim()
  if (!/^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(text)) return null
  const number = Number(text.replaceAll(',', ''))
  return Number.isFinite(number) && Math.abs(number) <= Number.MAX_SAFE_INTEGER ? number : null
}

function observation(row, date, index) {
  if (isoDay(row?.BAS_DD) !== date) return null
  const price = value(index ? row.CLSPRC_IDX : row.TDD_CLSPRC)
  if (price === null || price <= 0) return null
  return {
    price, change: value(index ? row.CMPPREVDD_IDX : row.CMPPREVDD_PRC), changePercent: value(row.FLUC_RT),
    open: value(index ? row.OPNPRC_IDX : row.TDD_OPNPRC), high: value(index ? row.HGPRC_IDX : row.TDD_HGPRC),
    low: value(index ? row.LWPRC_IDX : row.TDD_LWPRC), volume: value(row.ACC_TRDVOL),
    turnover: value(row.ACC_TRDVAL), marketCap: value(row.MKTCAP),
    ...(index ? {} : { listedShares: value(row.LIST_SHRS) }),
    tradingDate: date, observedAt: date, source,
  }
}

function unique(rows) {
  const byCode = new Map()
  for (const row of rows) byCode.set(row.symbol, byCode.has(row.symbol) ? null : row)
  return [...byCode.values()].filter(Boolean)
}

function normalize(path, rows, date) {
  const [market, config] = Object.entries(endpoint).find(([, entry]) => Object.values(entry).includes(path))
  if (path === config.index) {
    const matches = rows.filter(row => row?.IDX_NM === config.name && row.IDX_CLSS === market)
    const quote = matches.length === 1 && observation(matches[0], date, true)
    return quote ? [{ ...quote, indexClass: market, indexName: config.name }] : []
  }
  if (path === config.listings) return unique(rows.flatMap(row => {
    const symbol = row?.ISU_SRT_CD
    if (typeof symbol !== 'string' || !codePattern.test(symbol) || row.MKT_TP_NM !== market ||
      typeof row.ISU_ABBRV !== 'string' || !row.ISU_ABBRV.trim() ||
      !isDay(isoDay(row.LIST_DD)) || isoDay(row.LIST_DD) > date) return []
    return [{ symbol, market, name: row.ISU_ABBRV, englishName: row.ISU_ENG_NM?.trim() || '',
      fullName: row.ISU_NM?.trim() || row.ISU_ABBRV,
      isin: row.ISU_CD, listedOn: isoDay(row.LIST_DD), shareClass: row.KIND_STKCERT_TP_NM?.trim() || '' }]
  }))
  return unique(rows.flatMap(row => {
    const quote = observation(row, date, false)
    if (!quote || row.MKT_NM !== market || !codePattern.test(row.ISU_CD) || !row.ISU_NM?.trim()) return []
    return [{ ...quote, symbol: row.ISU_CD, name: row.ISU_NM, market }]
  }))
}

export function memberKrxCacheDir() {
  return process.env.KRX_MEMBER_CACHE_DIR?.trim() || fileURLToPath(new URL('.krx-cache/member/', import.meta.url))
}

export function configureMemberKrx({
  enabled = process.env.FINANCE_MEMBER_KRX,
  root = memberKrxCacheDir(),
  ...options
} = {}) {
  if (enabled === '1') return createKrxProvider({ ...options, root })
}

export function createKrxProvider({
  key = process.env.KRX_API_KEY,
  root = fileURLToPath(new URL('.krx-cache/', import.meta.url)),
  fetchImpl = fetch, clock = Date.now, log = () => {}, scheduled = false,
} = {}) {
  // A bounded number of KRX GETs are allowed per collection window and per process.
  const get = providerClient(fetchImpl, 150,
    { queue: true, dailyLimit: 300, detailedErrors: true, maxBytes: 4 * 1024 * 1024 })
  const states = new Map()
  const pending = new Map()
  const historyPending = new Map()
  let queue = Promise.resolve()

  async function request(path, date, { retries = 0, requests } = {}) {
    const url = new URL('https://data-dbg.krx.co.kr/svc/apis/' + path)
    url.searchParams.set('basDd', date.replaceAll('-', ''))
    const timeoutMs = path.endsWith('_bydd_trd') ? 10_000 : 5_000
    for (let retry = 0; ; retry++) {
      let httpStatus = null
      const call = queue.then(async () => {
        const at = new Date(clock()).toISOString()
        const start = performance.now()
        let code = null
        try {
          const body = await get(url, { AUTH_KEY: key.trim() }, timeoutMs, status => { httpStatus = status })
          if (!Array.isArray(body?.OutBlock_1)) throw new ProviderError(502, 'KRX_INVALID_RESPONSE')
          if (body.OutBlock_1.length === 0) return []
          const rows = normalize(path, body.OutBlock_1, date)
          if (!rows.length) throw new ProviderError(502, 'KRX_INVALID_OBSERVATIONS')
          return rows
        } catch (error) {
          code = { 400: 'KRX_INVALID_REQUEST', 401: 'KRX_AUTH_REJECTED', 403: 'KRX_ACCESS_DENIED' }[httpStatus]
            ?? error.code ?? 'KRX_UNAVAILABLE'
          if (code === error.code) throw error
          throw new ProviderError(502, code)
        } finally {
          const entry = { at, date, attempt: retry + 1, httpStatus, elapsedMs: Math.round(performance.now() - start), code }
          requests?.push(entry)
          log({ event: 'krx-request', endpoint: path, ...entry })
        }
      })
      queue = call.catch(() => {})
      try {
        return await call
      } catch (error) {
        const transient = retryableHttp.has(httpStatus) || error.code === 'PROVIDER_TIMEOUT'
          || error.code === 'PROVIDER_CONNECTION_ERROR'
        if (!transient || retry >= retries) throw error
        await delay(500 * 2 ** retry)
      }
    }
  }

  async function save(file, state) {
    const temp = file + '.' + randomUUID() + '.tmp'
    try {
      await mkdir(root, { recursive: true, mode: 0o700 })
      await writeFile(temp, JSON.stringify(state), { mode: 0o600, flag: 'wx' })
      await rename(temp, file)
    } catch {
      await unlink(temp).catch(() => {})
      return false
    }
    return true
  }

  const historyFile = (market, date) => join(root, 'ohlcv-' + market + '-' + date + '.json')
  async function readHistory(market, date) {
    const stored = await readFile(historyFile(market, date), 'utf8').then(JSON.parse).catch(() => null)
    return stored?.date === date && Array.isArray(stored.rows) ? stored : null
  }

  async function saveHistory(market, date, rows) {
    const bars = rows.map(toBar).filter(Boolean)
    if (rows.length && !bars.length) throw new ProviderError(502, 'KRX_INVALID_OBSERVATIONS')
    const noTrades = rows.filter(row => row.volume === 0).map(row => row.symbol)
    const stored = await save(historyFile(market, date), { date, rows: bars, noTrades })
    if (!stored) throw new ProviderError(503, 'KRX_HISTORY_CACHE_FAILED')
  }

  async function saveLatestHistory(path, date, rows) {
    const market = markets.find(name => endpoint[name].trades === path)
    if (market) await saveHistory(market, date, rows)
  }

  const stateFile = path => join(root, path.replaceAll('/', '-') + '.json')
  async function readState(path) {
    const stored = await readFile(stateFile(path), 'utf8').then(JSON.parse).catch(() => null)
    const valid = stored?.version === 1 && Array.isArray(stored.history) &&
      (!stored.data || (isDay(stored.data.date) && Array.isArray(stored.data.rows) && stored.data.rows.length))
    return valid ? stored : { version: 1, history: [] }
  }

  function getState(path) {
    if (!states.has(path)) states.set(path, readState(path))
    return states.get(path)
  }

  async function refresh(path, target) {
    const previous = await getState(path)
    const state = { ...previous }
    const metadataRefresh = path.endsWith('_base_info') && state.data?.date === target.date &&
      state.data.rows.some(row => !row.fullName)
    if (!key?.trim() || (!metadataRefresh && state.data?.date >= target.date) ||
      (state.attempt?.date === target.date && state.attempt.slot >= target.slot &&
        (!metadataRefresh || state.attempt.metadataRefresh))) return state
    const attempt = { date: target.date, slot: target.slot, at: new Date(clock()).toISOString(),
      result: 'empty', metadataRefresh, requests: [] }
    try {
      // On a cold cache, step past consecutive closed or unpublished days.
      for (let offset = 0; offset < (state.data ? 1 : 8); offset++) {
        const date = day(Date.parse(target.date) - offset * dayMs)
        if (weekend(date)) continue
        const rows = await request(path, date, { retries: offset === 0 ? 2 : 0, requests: attempt.requests })
        if (!rows.length) continue
        await saveLatestHistory(path, date, rows)
        state.data = { date, collectedAt: new Date(clock()).toISOString(), rows }
        attempt.result = date === target.date ? 'available' : 'fallback'
        break
      }
    } catch (error) {
      attempt.result = 'error'
      attempt.code = error instanceof ProviderError ? error.code : 'KRX_UNAVAILABLE'
    }
    state.attempt = attempt
    state.history = [...state.history, attempt].slice(-45)
    state.persisted = await save(stateFile(path), state)
    if (!state.persisted) {
      attempt.result = 'error'
      attempt.code = 'KRX_SNAPSHOT_CACHE_FAILED'
      state.data = previous.data
    }
    states.set(path, Promise.resolve(state))
    log({ event: 'krx-collection', endpoint: path, date: attempt.date, at: attempt.at,
      result: attempt.result, code: attempt.code, latestDate: state.data?.date ?? null,
      collectedAt: state.data?.collectedAt ?? null, persisted: state.persisted })
    return state
  }

  async function load(path, target = session(clock()), collect = false) {
    if (scheduled && !collect) return getState(path)
    if (!pending.has(path)) pending.set(path, refresh(path, target).finally(() => pending.delete(path)))
    return pending.get(path)
  }

  function metadata(state, target) {
    const current = state.data?.date === target.date
    const reason = !key?.trim() ? 'provider-not-configured'
      : current ? (target.weekend ? 'weekend' : target.beforeClose ? 'before-collection' : null)
        : state.attempt?.result === 'error' ? 'provider-error' : 'not-published'
    return { status: !state.data ? 'unavailable' : current ? 'available' : 'stale',
      reason, collectedAt: state.data?.collectedAt ?? null, source,
      ...(state.attempt?.result === 'error' && { errorCode: state.attempt.code }),
    }
  }

  async function stockHistory(symbol) {
    const target = session(clock())
    const catalogs = await Promise.all(markets.map(market => load(endpoint[market].listings, target)))
    const newestCatalogDate = catalogs.map(state => state.data?.date ?? '').sort().at(-1)
    const candidates = catalogs.flatMap(state => (state.data?.rows ?? [])
      .filter(row => row.symbol === symbol)
      .map(row => ({ ...row, catalogDate: state.data.date })))
    const matches = candidates.length > 1 ? candidates.filter(row => row.catalogDate === newestCatalogDate) : candidates
    if (matches.length !== 1) {
      if (catalogs.some(state => !state.data)) {
        const reasons = catalogs.map(state => metadata(state, target).reason)
        if (reasons.includes('provider-not-configured')) throw new ProviderError(503, 'KRX_NOT_CONFIGURED')
        if (reasons.includes('provider-error')) throw new ProviderError(503, 'KRX_UNAVAILABLE')
      }
      return null
    }
    const [{ market, name, listedOn }] = matches
    const trades = await load(endpoint[market].trades, target)
    const latest = trades.data
    const latestDate = latest?.date ?? null
    const latestQuote = latest?.rows.find(row => row.symbol === symbol && row.tradingDate >= listedOn) ?? null
    const bars = []
    let stoppedAt = null
    let stoppedReason = null
    for (const date of latestDate ? tradingCandidates(latestDate) : []) {
      if (bars.length >= historySessions) break
      if (date < listedOn) {
        stoppedAt = date
        stoppedReason = 'pre-listing'
        break
      }
      const cached = date === latestDate
        ? { rows: latest.rows.map(toBar).filter(Boolean), noTrades: latest.rows.filter(row => row.volume === 0).map(row => row.symbol) }
        : await readHistory(market, date)
      if (date !== latestDate && cached?.rows.length === 0) continue
      const row = cached?.rows.find(([code]) => code === symbol)
      if (!row) {
        stoppedAt = date
        stoppedReason = !cached ? 'not-collected'
          : Array.isArray(cached.noTrades) && cached.noTrades.includes(symbol) ? 'no-trades' : 'missing-observation'
        break
      }
      const [, open, high, low, close, volume] = row
      bars.push({ tradingDate: date, open, high, low, close, volume })
    }
    const { reason, errorCode } = metadata(trades, target)
    return { symbol, name, market, source, quote: latestQuote, reason, errorCode,
      latestDate, collectedAt: latest?.collectedAt ?? null, stoppedAt, stoppedReason,
      history: { currency: 'KRW', timeZone: 'Asia/Seoul', adjustment: 'unadjusted',
        completeness: bars.length ? 'complete' : 'missing-observations', bars: bars.reverse() } }
  }

  function checkBatch(limit) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 145) throw new Error('Invalid KRX backfill configuration')
  }

  async function backfillPlan(limit = 140) {
    checkBatch(limit)
    const target = session(clock())
    const results = {}
    for (const market of markets) {
      let cachedSessions = 0, marketEmptyDays = 0, missingWeekdays = 0
      for (const date of tradingCandidates(target.date)) {
        const cached = await readHistory(market, date)
        if (!cached) missingWeekdays++
        else if (cached.rows.length) cachedSessions++
        else marketEmptyDays++
        if (cachedSessions === historySessions) break
      }
      results[market] = { cachedSessions, marketEmptyDays, missingWeekdays,
        targetSessions: historySessions, minimumAdditionalSessions: historySessions - cachedSessions, requestCap: limit }
    }
    return { targetDate: target.date, latestLookupMax: 12, maxRequestsPerRun: Math.min(300, 2 * limit + 12), markets: results }
  }

  let backfillPending
  async function runBackfill(limit) {
    checkBatch(limit)
    if (!key?.trim()) throw new Error('Invalid KRX backfill configuration')
    const target = session(clock())
    const results = {}
    for (const market of markets) {
      const path = endpoint[market].trades
      const state = await load(path, target, true)
      if (state.attempt?.date === target.date && backfillStopCodes.has(state.attempt.code)) {
        throw new ProviderError(503, state.attempt.code)
      }
      const latest = state.data
      if (!latest) throw new Error('Latest KRX trading date unavailable')
      const result = { requested: 0, sessions: 0, empty: 0, failures: [], oldest: latest.date, latest: latest.date }
      let availableSessions = 0
      for (const date of tradingCandidates(latest.date)) {
        if (availableSessions >= historySessions) break
        if (date === latest.date) {
          if (!(await readHistory(market, date))) await saveHistory(market, date, latest.rows)
          availableSessions++
          continue
        }
        const cached = await readHistory(market, date)
        if (cached) {
          if (cached.rows.length) {
            availableSessions++
            result.oldest = date
          }
          continue
        }
        if (result.requested >= limit) break
        result.requested++
        try {
          const rows = await request(path, date)
          await saveHistory(market, date, rows)
          if (rows.length) { result.sessions++; availableSessions++; result.oldest = date }
          else result.empty++
        } catch (error) {
          if (backfillStopCodes.has(error.code)) throw error
          result.failures.push({ date, code: error.code ?? 'KRX_UNAVAILABLE' })
        }
      }
      results[market] = { ...result, availableSessions }
    }
    return results
  }

  async function overview() {
    const target = session(clock())
    const datasets = await Promise.all(markets.map(market => load(endpoint[market].trades, target)))
    const date = datasets[0].data?.date
    if (!date || datasets.some(state => state.data?.date !== date)) {
      const reasons = datasets.map(state => metadata(state, target).reason)
      const reason = ['provider-not-configured', 'provider-error'].find(value => reasons.includes(value))
        ?? 'same-date-data-unavailable'
      return { source, tradingDate: null, collectedAt: null, reason,
        leaders: null, tiles: [], marketTiles: { KOSPI: [], KOSDAQ: [] } }
    }
    const catalogs = await Promise.all(markets.map(market => load(endpoint[market].listings, target)))
    const names = new Map(catalogs.flatMap(state => state.data?.date === date ? state.data.rows : [])
      .map(row => [row.market + ':' + row.symbol, row]))
    const rows = datasets.flatMap(state => state.data.rows.filter(row => row.volume > 0))
      .map(({ symbol, market, price, changePercent, volume, marketCap }) => {
        const listing = names.get(market + ':' + symbol)
        return { symbol, name: listing?.fullName || listing?.name || symbol, shortName: listing?.name ?? symbol,
          mapped: Boolean(listing), market, price, changePercent, volume, marketCap }
      })
    const top = (field, direction, filter = () => true) => rows.filter(filter)
      .sort((a, b) => direction * (a[field] - b[field]) || a.symbol.localeCompare(b.symbol))
    const tiles = top('marketCap', -1, row => row.marketCap > 0 && Number.isFinite(row.changePercent))
    return { source, tradingDate: date, collectedAt: datasets.map(state => state.data.collectedAt).sort().at(-1),
      reason: datasets.map(state => metadata(state, target).reason).find(Boolean) ?? null,
      leaders: {
        advances: top('changePercent', -1, row => row.changePercent > 0).slice(0, 5),
        declines: top('changePercent', 1, row => row.changePercent < 0).slice(0, 5),
        volume: top('volume', -1).slice(0, 5),
      },
      tiles: tiles.slice(0, 60),
      marketTiles: Object.fromEntries(markets.map(market => [market, tiles.filter(row => row.market === market).slice(0, 60)])) }
  }

  return {
    stockHistory(symbol) {
      if (!historyPending.has(symbol)) historyPending.set(symbol, stockHistory(symbol).finally(() => historyPending.delete(symbol)))
      return historyPending.get(symbol)
    },
    backfillPlan,
    backfill(limit = 140) {
      checkBatch(limit)
      if (backfillPending) throw new ProviderError(503, 'KRX_BACKFILL_BUSY')
      backfillPending = runBackfill(limit).finally(() => { backfillPending = undefined })
      return backfillPending
    },
    overview,
    async indices(market) {
      const target = session(clock())
      const state = await load(endpoint[market].index, target)
      return { ...state.data?.rows[0], ...metadata(state, target) }
    },
    async stocks({ market, q, symbol, symbols }) {
      const target = session(clock())
      const config = endpoint[market]
      const listings = await load(config.listings, target)
      const trades = await load(config.trades, target)
      const byCode = new Map(trades.data?.rows.map(row => [row.symbol, row]))
      const term = q?.trim().toLowerCase()
      const exact = symbols && new Set(symbols)
      const matches = (listings.data?.rows ?? []).filter(row => {
        if (exact) return exact.has(row.symbol)
        if (symbol) return row.symbol === symbol
        return !term || [row.symbol, row.name, row.fullName, row.englishName]
          .some(text => text?.toLowerCase().includes(term))
      })
      if (term) matches.sort((a, b) => Number(b.symbol === term.toUpperCase()) - Number(a.symbol === term.toUpperCase()))
      return { market, listings: metadata(listings, target),
        trades: { ...metadata(trades, target), tradingDate: trades.data?.date ?? null },
        listingDate: listings.data?.date ?? null, items: matches.slice(0, 20).map(row => ({
          ...row, quote: trades.data && row.listedOn <= trades.data.date
            ? byCode.get(row.symbol) ?? null : null,
        })) }
    },
    async collect() {
      const target = session(clock())
      for (const path of services) await load(path, target, true)
    },
  }
}
