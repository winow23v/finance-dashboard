import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDay, providerClient, ProviderError } from './public-provider.mjs'
import { createKrxCalendar, krxCollectionSession, day, dayMs, koreanOffset, weekend } from './krx-calendar-provider.mjs'

const source = 'KRX OPEN API'
const endpoint = {
  KOSPI: { index: 'idx/kospi_dd_trd', trades: 'sto/stk_bydd_trd', listings: 'sto/stk_isu_base_info', name: '코스피' },
  KOSDAQ: { index: 'idx/kosdaq_dd_trd', trades: 'sto/ksq_bydd_trd', listings: 'sto/ksq_isu_base_info', name: '코스닥' },
}
const services = Object.values(endpoint).flatMap(({ index, trades, listings }) => [index, trades, listings])
const minutes = [16 * 60 + 30, 17 * 60 + 30, 19 * 60]
const isoDay = value => typeof value === 'string' ? value.replace(/^(\d{4})(\d\d)(\d\d)$/, '$1-$2-$3') : ''
const codePattern = /^[0-9A-Z]{6}$/
const historyDays = 540
const markets = Object.keys(endpoint)

function * tradingCandidates(date, closed = weekend) {
  for (let offset = 0; offset < historyDays; offset++) {
    const candidate = day(Date.parse(date) - offset * dayMs)
    if (!closed(candidate)) yield candidate
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
  return { date: day(prior), slot: 2, weekend: weekend(today), beforeClose: !weekend(today) }
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

export function configureMemberKrx({
  enabled = process.env.FINANCE_MEMBER_KRX,
  root = process.env.KRX_MEMBER_CACHE_DIR?.trim() || fileURLToPath(new URL('.krx-cache/member/', import.meta.url)),
  ...options
} = {}) {
  if (enabled === '1') return createKrxProvider({ ...options, root, scheduledOnly: true })
}

export function createKrxProvider({
  key = process.env.KRX_API_KEY,
  root = fileURLToPath(new URL('.krx-cache/', import.meta.url)),
  fetchImpl = fetch, clock = Date.now, scheduledOnly = false, calendar = createKrxCalendar(),
} = {}) {
  // A bounded number of KRX GETs are allowed per collection window and per process.
  let blockedUntil = 0
  let cooldownLoaded = false
  const cooldownFile = join(root, 'krx-regular-cooldown.json')
  const afterCheckFile = join(root, 'krx-after-hours-check.json')
  let afterCheck
  let collection
  const targetFor = () => scheduledOnly ? krxCollectionSession(clock(), calendar) : session(clock())
  const get = providerClient(async (...args) => {
    const response = await fetchImpl(...args)
    if (response.status === 429 && scheduledOnly) {
      const header = response.headers.get('retry-after')
      const resume = header && /^\d+$/.test(header) ? clock() + Number(header) * 1000 : Date.parse(header ?? '')
      blockedUntil = Math.max(clock() + 30 * 60_000, Number.isFinite(resume) ? resume : 0)
      await save(cooldownFile, { blockedUntil })
    }
    const code = { 400: 'KRX_INVALID_REQUEST', 401: 'KRX_AUTH_REJECTED', 403: 'KRX_ACCESS_DENIED' }[response.status]
    if (code) {
      await response.body?.cancel().catch(() => {})
      throw new ProviderError(502, code)
    }
    return response
  }, 150, { queue: true, dailyLimit: 300, timeoutMs: 3500, maxBytes: 4 * 1024 * 1024 })
  const states = new Map()
  const pending = new Map()
  const historyPending = new Map()
  let queue = Promise.resolve()

  async function request(path, date) {
    const url = new URL('https://data-dbg.krx.co.kr/svc/apis/' + path)
    url.searchParams.set('basDd', date.replaceAll('-', ''))
    const call = queue.then(() => {
      if (clock() < blockedUntil) throw new ProviderError(503, 'PROVIDER_RATE_LIMITED')
      return get(url, { AUTH_KEY: key.trim() })
    })
    queue = call.catch(() => {})
    const body = await call
    if (!Array.isArray(body?.OutBlock_1)) throw new ProviderError(502, 'KRX_INVALID_RESPONSE')
    if (body.OutBlock_1.length === 0) return []
    const rows = normalize(path, body.OutBlock_1, date)
    if (!rows.length) throw new ProviderError(502, 'KRX_INVALID_OBSERVATIONS')
    return rows
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
    const stored = await save(historyFile(market, date), { date, rows: bars })
    if (!stored) throw new ProviderError(503, 'KRX_HISTORY_CACHE_FAILED')
  }

  async function saveLatestHistory(path, date, rows) {
    const market = markets.find(name => endpoint[name].trades === path)
    if (!market) return
    const stored = saveHistory(market, date, rows)
    if (scheduledOnly) await stored
    else await stored.catch(() => {})
  }

  async function readState(path) {
    const file = join(root, path.replaceAll('/', '-') + '.json')
    if (!states.has(path)) {
      const stored = await readFile(file, 'utf8').then(JSON.parse).catch(() => null)
      const valid = stored?.version === 1 && Array.isArray(stored.history) &&
        (!stored.data || (isDay(stored.data.date) && Array.isArray(stored.data.rows) && stored.data.rows.length))
      if (!states.has(path)) states.set(path, valid ? stored : { version: 1, history: [] })
    }
    return states.get(path)
  }

  async function refresh(path, target) {
    const file = join(root, path.replaceAll('/', '-') + '.json')
    const previous = await readState(path)
    const state = { ...previous }
    const metadataRefresh = path.endsWith('_base_info') && state.data?.date === target.date &&
      state.data.rows.some(row => !row.fullName)
    const alreadyAttempted = state.attempt?.date === target.date && (scheduledOnly
      ? Date.parse(state.attempt.at) >= target.slotStart : state.attempt.slot >= target.slot)
    if (!key?.trim() || (!metadataRefresh && state.data?.date >= target.date) ||
      (scheduledOnly && (!target.canCollect || clock() < blockedUntil)) ||
      (alreadyAttempted && (scheduledOnly || !metadataRefresh || state.attempt.metadataRefresh))) return previous
    const attempt = { date: target.date, slot: target.slot, at: new Date(clock()).toISOString(), result: 'empty', metadataRefresh }
    if (scheduledOnly) {
      // Reserve this window on disk before calling upstream. A restart must not
      // turn a previously dispatched request into another request in the same slot.
      const reservation = { ...previous, attempt: { ...attempt, result: 'pending' } }
      if (!(await save(file, reservation))) {
        const failed = { ...previous, attempt: { ...attempt, result: 'error', code: 'KRX_REGULAR_CACHE_FAILED' } }
        states.set(path, failed)
        return failed
      }
      states.set(path, reservation)
    }
    try {
      // On a cold cache, step past consecutive closed or unpublished days.
      for (let offset = 0; offset < (scheduledOnly || state.data ? 1 : 8); offset++) {
        const date = day(Date.parse(target.date) - offset * dayMs)
        if (weekend(date)) continue
        const rows = await request(path, date)
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
    if (!(await save(file, state))) {
      const failed = { ...previous, attempt: { ...attempt, result: 'error', code: 'KRX_REGULAR_CACHE_FAILED' } }
      states.set(path, failed)
      return failed
    }
    states.set(path, state)
    return state
  }

  async function load(path, target = targetFor(), collect = false) {
    if (scheduledOnly && !collect) return readState(path)
    if (!pending.has(path)) pending.set(path, refresh(path, target).finally(() => pending.delete(path)))
    return pending.get(path)
  }

  function metadata(state, target) {
    const current = state.data?.date === target.date
    const reason = !key?.trim() ? 'provider-not-configured'
      : scheduledOnly && !target.known ? 'provider-not-configured'
        : target.closed ? 'weekend'
          : current ? (target.weekend ? 'weekend' : target.beforeClose ? 'before-collection' : null)
        : state.attempt?.date === target.date && state.attempt?.result === 'error' ? 'provider-error' : 'not-published'
    return { status: !state.data ? 'unavailable' : current ? 'available' : 'stale',
      reason, collectedAt: state.data?.collectedAt ?? null, source,
      ...(state.attempt?.date === target.date && state.attempt.result === 'error' && { errorCode: state.attempt.code }),
    }
  }

  async function stockHistory(symbol) {
    const target = targetFor()
    const catalogs = await Promise.all(markets.map(market => load(endpoint[market].listings, target)))
    const matches = catalogs.flatMap(state => state.data?.rows.filter(row => row.symbol === symbol) ?? [])
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
    const latest = trades.data ?? null
    const latestDate = latest?.date ?? null
    const latestQuote = latest?.rows.find(row => row.symbol === symbol && row.tradingDate >= listedOn) ?? null
    const bars = []
    let stoppedAt = null
    let stoppedReason = null
    for (const date of latestDate ? tradingCandidates(latestDate, scheduledOnly ? calendar.closed : weekend) : []) {
      if (date < listedOn) break
      const cached = date === latestDate
        ? { rows: latest.rows.map(toBar).filter(Boolean) } : await readHistory(market, date)
      if (date !== latestDate && cached?.rows.length === 0) continue
      const row = cached?.rows.find(([code]) => code === symbol)
      if (!row) {
        stoppedAt = date
        stoppedReason = cached ? 'missing-observation' : 'not-collected'
        break
      }
      const [, open, high, low, close, volume] = row
      bars.push({ tradingDate: date, open, high, low, close, volume })
    }
    return { symbol, name, market, source, quote: latestQuote, reason: metadata(trades, target).reason,
      latestDate, collectedAt: latest?.collectedAt ?? null, stoppedAt, stoppedReason,
      afterHours: afterHours(target),
      history: { currency: 'KRW', timeZone: 'Asia/Seoul', adjustment: 'unadjusted',
        completeness: bars.length ? 'complete' : 'missing-observations', bars: bars.reverse() } }
  }

  async function backfill(limit = 140) {
    if (!key?.trim() || !Number.isInteger(limit) || limit < 1 || limit > 145) throw new Error('Invalid KRX backfill configuration')
    const target = targetFor()
    const results = {}
    for (const market of markets) {
      const path = endpoint[market].trades
      const latest = (await load(path, target)).data
      if (!latest) throw new Error('Latest KRX trading date unavailable')
      const result = { requested: 0, sessions: 0, empty: 0, failures: [], oldest: latest.date, latest: latest.date }
      for (const date of tradingCandidates(latest.date)) {
        if (date === latest.date) {
          if (!(await readHistory(market, date))) await saveHistory(market, date, latest.rows)
          continue
        }
        const cached = await readHistory(market, date)
        if (cached) continue
        if (result.requested >= limit) break
        result.requested++
        try {
          const rows = await request(path, date)
          await saveHistory(market, date, rows)
          if (rows.length) { result.sessions++; result.oldest = date }
          else result.empty++
        } catch (error) {
          if (['PROVIDER_RATE_LIMITED', 'KRX_BACKFILL_BUDGET', 'KRX_AUTH_REJECTED',
            'KRX_ACCESS_DENIED', 'KRX_HISTORY_CACHE_FAILED'].includes(error.code)) throw error
          result.failures.push({ date, code: error.code ?? 'KRX_UNAVAILABLE' })
        }
      }
      results[market] = result
    }
    return results
  }

  async function overview() {
    const target = targetFor()
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

  function afterHours(target) {
    if (!scheduledOnly) return undefined
    return ['KRX', 'NXT'].map(venue => ({
      venue, status: target.closed ? 'market-closed' : !target.known ? 'calendar-unavailable' : 'provider-unavailable',
      tradingDate: target.today, scheduledCheckAt: target.afterCheckAt,
      connectionCheckedAt: afterCheck?.date === target.today ? afterCheck.at : null,
      eligibility: 'unknown', source: null, price: null, observedAt: null, collectedAt: null,
    }))
  }

  async function runCollection(signal) {
    if (signal?.aborted) return
    const target = targetFor()
    if (scheduledOnly && !target.closed && target.known && clock() >= Date.parse(target.afterCheckAt) &&
      afterCheck?.date !== target.today) {
      // No authorized after-hours price adapter is configured. Record only the
      // connection check, never a price observation or a provider call.
      const saved = await readFile(afterCheckFile, 'utf8').then(JSON.parse).catch(() => null)
      if (saved?.date === target.today && Number.isFinite(Date.parse(saved.at))) afterCheck = saved
      else {
        afterCheck = { date: target.today, at: new Date(clock()).toISOString() }
        await save(afterCheckFile, afterCheck)
      }
    }
    if (scheduledOnly && !target.canCollect) return
    if (scheduledOnly && !cooldownLoaded) {
      const saved = await readFile(cooldownFile, 'utf8').then(JSON.parse).catch(() => null)
      if (Number.isFinite(saved?.blockedUntil)) blockedUntil = Math.max(blockedUntil, saved.blockedUntil)
      cooldownLoaded = true
    }
    for (const path of services) {
      if (signal?.aborted) break
      await load(path, target, true)
    }
  }

  return {
    stockHistory(symbol) {
      if (!historyPending.has(symbol)) historyPending.set(symbol, stockHistory(symbol).finally(() => historyPending.delete(symbol)))
      return historyPending.get(symbol)
    },
    backfill,
    overview,
    async indices(market) {
      const target = targetFor()
      const state = await load(endpoint[market].index, target)
      return { ...state.data?.rows[0], ...metadata(state, target) }
    },
    async stocks({ market, q, symbol, symbols }) {
      const target = targetFor()
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
      return { market, listings: metadata(listings, target), trades: metadata(trades, target), afterHours: afterHours(target),
        listingDate: listings.data?.date ?? null, items: matches.slice(0, 20).map(row => ({
          ...row, quote: trades.data && row.listedOn <= trades.data.date
            ? byCode.get(row.symbol) ?? null : null,
        })) }
    },
    collect(signal) {
      collection ??= runCollection(signal).finally(() => { collection = undefined })
      return collection
    },
  }
}
