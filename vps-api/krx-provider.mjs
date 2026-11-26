import { spawn } from 'node:child_process'
import { get as httpsGet } from 'node:https'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import { isDay, isTransientNetworkError, providerClient, ProviderError } from './public-provider.mjs'
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
const nameText = value => typeof value === 'string' ? value.trim() : ''
const shortCode = value => {
  const code = nameText(value).toUpperCase()
  return /^\d{1,6}$/.test(code) ? code.padStart(6, '0') : codePattern.test(code) ? code : null
}

function fetchKrx(url, { headers, signal }, timings) {
  return new Promise((resolve, reject) => {
    let start = performance.now()
    const mark = stage => {
      const now = performance.now()
      timings[stage] = Math.round(now - start)
      start = now
    }
    // A dedicated connection makes DNS, TCP and TLS individually observable.
    const request = httpsGet(url, { agent: false, headers: { ...headers, 'Accept-Encoding': 'identity' }, signal }, response => {
      mark('headersMs')
      resolve({ status: response.statusCode, ok: response.statusCode >= 200 && response.statusCode < 300,
        headers: new Headers(response.headers), body: Readable.toWeb(response) })
    })
    request.once('socket', socket => {
      socket.once('lookup', error => { if (!error) mark('dnsMs') })
      socket.once('connect', () => mark('connectMs'))
      socket.once('secureConnect', () => mark('tlsMs'))
    })
    request.once('error', reject)
  })
}
const historyDays = 780
const historySessions = 500
const firstOfficialDate = '2010-01-04'
const markets = Object.keys(endpoint)
const backfillStopCodes = new Set(['PROVIDER_RATE_LIMITED', 'KRX_BACKFILL_BUDGET', 'KRX_AUTH_REJECTED',
  'KRX_ACCESS_DENIED', 'KRX_HISTORY_CACHE_FAILED'])
const requestLimit = 300
const defaultTimeouts = { index: 10_000, trades: 30_000, listings: 20_000 }

function requestKind(path) {
  return path.endsWith('_bydd_trd') ? 'trades' : path.endsWith('_base_info') ? 'listings' : 'index'
}
const recoveryLookback = 10
const recoveryLimit = 4
const retryableHttp = new Set([408, 500, 502, 503, 504])

function * tradingCandidates(date, closed = weekend) {
  for (let offset = 0; offset < historyDays; offset++) {
    const candidate = day(Date.parse(date) - offset * dayMs)
    if (candidate < firstOfficialDate) break
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

function listingDisplayName(symbol, listing, tradeName) {
  return nameText(listing?.name) || nameText(tradeName) || symbol
}

function matchesTrade(listing, trade, catalogDate, tradeDate) {
  if (!listing || !trade || (trade.market && listing.market !== trade.market) ||
      !isDay(listing.listedOn) || listing.listedOn > tradeDate) return false
  if (catalogDate === tradeDate) return true
  const name = nameText(trade.name).normalize('NFC')
  return Boolean(name) && name !== trade.symbol &&
    [listing.name, listing.fullName].some(value => nameText(value).normalize('NFC') === name)
}

function normalize(path, rows, date) {
  const [market, config] = Object.entries(endpoint).find(([, entry]) => Object.values(entry).includes(path))
  if (path === config.index) {
    const matches = rows.filter(row => row?.IDX_NM === config.name && row.IDX_CLSS === market)
    const quote = matches.length === 1 && observation(matches[0], date, true)
    return quote ? [{ ...quote, indexClass: market, indexName: config.name }] : []
  }
  if (path === config.listings) return unique(rows.flatMap(row => {
    const symbol = shortCode(row?.ISU_SRT_CD)
    if (!symbol || row.MKT_TP_NM !== market || !nameText(row.ISU_ABBRV) ||
      !isDay(isoDay(row.LIST_DD)) || isoDay(row.LIST_DD) > date) return []
    return [{ symbol, market, name: nameText(row.ISU_ABBRV), englishName: nameText(row.ISU_ENG_NM),
      fullName: nameText(row.ISU_NM) || nameText(row.ISU_ABBRV),
      isin: row.ISU_CD, listedOn: isoDay(row.LIST_DD), shareClass: nameText(row.KIND_STKCERT_TP_NM) }]
  }))
  return unique(rows.flatMap(row => {
    const quote = observation(row, date, false)
    const symbol = shortCode(row?.ISU_CD)
    if (!quote || row.MKT_NM !== market || !symbol || !nameText(row.ISU_NM)) return []
    return [{ ...quote, symbol, name: nameText(row.ISU_NM), market }]
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
  if (enabled === '1') return createKrxProvider({ ...options, root, scheduledOnly: true })
}

export function createKrxProvider({
  key = process.env.KRX_API_KEY,
  root = fileURLToPath(new URL('.krx-cache/', import.meta.url)),
  fetchImpl = fetchKrx, retryDelays = [2_000, 5_000], timeouts = defaultTimeouts, clock = Date.now, scheduledOnly = false, calendar = createKrxCalendar(),
  log = scheduledOnly ? entry => console.info(JSON.stringify(entry)) : () => {},
} = {}) {
  const ledgerFile = join(root, 'krx-request-budget.json')
  const recoverySnapshot = (path, date) => join(root, 'krx-recovered-' + path.replaceAll('/', '-') + '-' + date + '.json')
  const cooldownFile = join(root, 'krx-regular-cooldown.json')
  const recoveryWindowFile = join(root, 'krx-recovery-window.json')
  const recoveryFile = join(root, 'krx-missing-recovery.json')
  const afterCheckFile = join(root, 'krx-after-hours-check.json')
  let afterCheck
  let collection
  let completedSlot
  let ledger
  let operation = Promise.resolve()
  const targetFor = () => scheduledOnly ? krxCollectionSession(clock(), calendar) : session(clock())
  const historyClosed = scheduledOnly ? calendar.closed : weekend
  const get = providerClient(async (url, options, timings) => {
    let response
    try {
      response = await fetchImpl(url, options, timings)
    } catch (error) {
      if (error instanceof ProviderError || options.signal.aborted) throw error
      if (isTransientNetworkError(error)) throw error
      throw new ProviderError(502, 'PROVIDER_UNAVAILABLE')
    }
    if (response.status === 429) {
      const header = response.headers.get('retry-after')
      const resume = header && /^\d+$/.test(header) ? clock() + Number(header) * 1000 : Date.parse(header ?? '')
      ledger.blockedUntil = Number.isFinite(resume) && resume >= clock() ? resume : clock() + 30 * 60_000
      await persistLedger()
    }
    return response
  }, 150, { queue: true, detailedErrors: true, maxBytes: 4 * 1024 * 1024 })

  async function readJson(file) {
    try {
      return JSON.parse(await readFile(file, 'utf8'))
    } catch (error) {
      if (error.code === 'ENOENT') return undefined
      throw error
    }
  }

  async function persistLedger() {
    if (!(await save(ledgerFile, ledger))) throw new ProviderError(503, 'KRX_BACKFILL_BUDGET')
  }

  async function readLedger() {
    try {
      const saved = await readJson(ledgerFile)
      if (saved !== undefined) {
        if (!saved || !Array.isArray(saved.requests) || !saved.requests.every(Number.isFinite) ||
            !Number.isFinite(saved.blockedUntil) || !Number.isFinite(saved.lastDispatch)) throw new Error()
        return saved
      }
      const cooldown = await readJson(cooldownFile)
      if (cooldown !== undefined && !Number.isFinite(cooldown?.blockedUntil)) throw new Error()
      const now = clock()
      const requests = []
      for (const kstDate of [day(now + koreanOffset - dayMs), day(now + koreanOffset)]) {
        const prior = await readFile(join(root, 'backfill-' + kstDate + '.jsonl'), 'utf8').catch(error => {
          if (error.code === 'ENOENT') return ''
          throw error
        })
        let earlierUsage = 0
        for (const line of prior.split('\n').filter(Boolean)) {
          const record = JSON.parse(line)
          const at = Date.parse(record.at)
          if (!Number.isFinite(at)) throw new Error()
          if (at <= now - dayMs) continue
          if (record.event === 'request') requests.push(at)
          if (record.event === 'prior' && Number.isSafeInteger(record.count) && record.count > 0) {
            earlierUsage = Math.max(earlierUsage, Math.min(requestLimit, record.count))
          }
        }
        requests.push(...Array(earlierUsage).fill(Math.min(now, Date.parse(kstDate + 'T23:59:59.999+09:00'))))
      }
      // Preserve recent scheduled usage when starting from the legacy cache format.
      for (const path of services) {
        const { attempt, history } = await readSnapshot(path)
        const seen = new Set()
        for (const entry of [...history, attempt]) {
          for (const request of Array.isArray(entry?.requests) ? entry.requests : []) {
            const at = Date.parse(request?.at)
            const id = request?.at + ':' + request?.date + ':' + request?.attempt
            if (at <= now - dayMs || !Number.isFinite(at) || seen.has(id)) continue
            requests.push(at)
            seen.add(id)
          }
        }
      }
      return { requests, blockedUntil: cooldown?.blockedUntil ?? 0, lastDispatch: 0 }
    } catch {
      throw new ProviderError(503, 'KRX_BACKFILL_BUDGET')
    }
  }

  function exclusive(task) {
    const run = operation.then(async () => {
      await mkdir(root, { recursive: true, mode: 0o700 })
      // flock is released by the OS when the pipe closes, including on a crash.
      const lock = spawn('flock', ['-n', join(root, 'backfill.flock'), 'sh', '-c',
        'echo locked; cat >/dev/null'], { stdio: ['pipe', 'pipe', 'ignore'] })
      lock.stdin.on('error', () => {})
      lock.on('error', () => {})
      const closed = new Promise(resolve => lock.once('close', resolve))
      const acquired = await Promise.race([closed.then(() => false),
        new Promise(resolve => lock.stdout.once('data', chunk => resolve(chunk.toString().startsWith('locked'))))])
      try {
        if (!acquired) throw new ProviderError(503, 'KRX_BACKFILL_BUSY')
        ledger = await readLedger()
        return await task()
      } finally {
        lock.stdin.end()
        await closed
      }
    })
    operation = run.catch(() => {})
    return run
  }

  function remainingRequests(budget = ledger, now = clock()) {
    return Math.max(0, requestLimit - budget.requests.filter(at => at > now - dayMs).length)
  }

  async function reserveRequest() {
    const now = clock()
    if (now < ledger.blockedUntil || remainingRequests(ledger, now) <= 0) {
      throw new ProviderError(503, 'PROVIDER_RATE_LIMITED')
    }
    const wait = ledger.lastDispatch + 150 - Date.now()
    if (wait > 0) await delay(wait)
    ledger.requests = [...ledger.requests.filter(at => at > now - dayMs), now]
    ledger.lastDispatch = Date.now()
    await persistLedger()
  }
  const states = new Map()
  const pending = new Map()
  const mappingReported = new Map()
  const historyPending = new Map()
  let queue = Promise.resolve()

  async function request(path, date, { retries = 0, requests } = {}) {
    const url = new URL('https://data-dbg.krx.co.kr/svc/apis/' + path)
    url.searchParams.set('basDd', date.replaceAll('-', ''))
    const kind = requestKind(path)
    const timeoutMs = timeouts[kind] ?? defaultTimeouts[kind]
    for (let retry = 0; ; retry++) {
      let httpStatus = null
      const call = queue.then(async () => {
        await reserveRequest()
        const at = new Date(clock()).toISOString()
        const start = performance.now()
        let code = null
        const timings = { dnsMs: null, connectMs: null, tlsMs: null, headersMs: null, bodyMs: null, jsonMs: null }
        try {
          const body = await get(url, { AUTH_KEY: key.trim() }, timeoutMs, status => { httpStatus = status }, timings)
          if (!Array.isArray(body?.OutBlock_1)) throw new ProviderError(502, 'KRX_INVALID_RESPONSE')
          if (body.OutBlock_1.length === 0) return []
          const rows = normalize(path, body.OutBlock_1, date)
          if (!rows.length) throw new ProviderError(502, 'KRX_INVALID_OBSERVATIONS')
          if (kind === 'listings' && rows.length !== body.OutBlock_1.length)
            throw new ProviderError(502, 'KRX_INCOMPLETE_MASTER')
          return rows
        } catch (error) {
          code = { 400: 'KRX_INVALID_REQUEST', 401: 'KRX_AUTH_REJECTED', 403: 'KRX_ACCESS_DENIED' }[httpStatus]
            ?? (error.transientNetwork === true ? 'PROVIDER_CONNECTION_ERROR' : error.code) ?? 'KRX_UNAVAILABLE'
          if (code === error.code) throw error
          throw new ProviderError(502, code)
        } finally {
          const entry = { at, date, attempt: retry + 1, httpStatus, timeoutMs, timings, elapsedMs: Math.round(performance.now() - start), code }
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
        await delay(retryDelays[retry])
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
    if (stored?.date !== date || !Array.isArray(stored.rows) ||
        (stored.noTrades !== undefined && (!Array.isArray(stored.noTrades) ||
          !stored.noTrades.every(code => typeof code === 'string' && codePattern.test(code))))) return null
    const symbols = new Set()
    for (const row of stored.rows) {
      if (!Array.isArray(row) || row.length !== 6) return null
      const [symbol, open, high, low, price, volume] = row
      if (typeof symbol !== 'string' || !codePattern.test(symbol) || symbols.has(symbol) ||
          !toBar({ symbol, open, high, low, price, volume })) return null
      symbols.add(symbol)
    }
    return stored
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
    if (!market) return
    if ((await readHistory(market, date))?.rows.length) return
    const stored = saveHistory(market, date, rows)
    if (scheduledOnly) await stored
    else await stored.catch(() => {})
  }

  async function readSnapshot(path) {
    const file = join(root, path.replaceAll('/', '-') + '.json')
    const stored = await readFile(file, 'utf8').then(JSON.parse).catch(() => null)
    const valid = data => isDay(data?.date) && Array.isArray(data.rows) && data.rows.length
    if (stored?.version !== 1 || !Array.isArray(stored.history) || (stored.data && !valid(stored.data))) {
      return { version: 1, history: [] }
    }
    if (stored.previousData && !valid(stored.previousData)) delete stored.previousData
    return stored
  }

  async function readState(path) {
    if (!states.has(path)) {
      const stored = await readSnapshot(path)
      if (!states.has(path)) states.set(path, stored)
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
      (scheduledOnly && (!target.canCollect)) ||
      (alreadyAttempted && (scheduledOnly || !metadataRefresh || state.attempt.metadataRefresh))) return previous
    if (scheduledOnly && !path.endsWith('_base_info')) {
      const recovered = (await readJson(recoveryFile))?.[path + ':' + target.date]
      if (recovered && recovered.status !== 'available' && Date.parse(recovered.at) >= target.slotStart) {
        return previous
      }
    }
    const attempt = { date: target.date, slot: target.slot, at: new Date(clock()).toISOString(), result: 'empty', metadataRefresh, requests: [] }
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
        const staged = await readFile(recoverySnapshot(path, date), 'utf8').then(JSON.parse).catch(() => null)
        const rows = staged?.date === date && Array.isArray(staged.rows) && staged.rows.length ? staged.rows :
          await request(path, date, { retries: offset === 0 ? 2 : 0, requests: attempt.requests })
        if (!rows.length) continue
        if (path.endsWith('_base_info') && state.data) {
          const market = rows[0].market
          const trades = (await readState(endpoint[market].trades)).data
          const codes = new Set(rows.map(row => row.symbol))
          const traded = new Map(trades?.date === date ? trades.rows.map(row => [row.symbol, row]) : [])
          const missingKnownIssue = state.data.rows.some(row => !codes.has(row.symbol) &&
            matchesTrade(row, traded.get(row.symbol), state.data.date, date))
          if (rows.length < state.data.rows.length * 0.9 || missingKnownIssue)
            throw new ProviderError(502, 'KRX_INCOMPLETE_MASTER')
        }
        await saveLatestHistory(path, date, rows)
        if (state.data && state.data.date < date) state.previousData = state.data
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
    const persisted = await save(file, state)
    const published = persisted ? state : {
      ...previous, attempt: { ...attempt, result: 'error', code: 'KRX_REGULAR_CACHE_FAILED' },
    }
    states.set(path, published)
    if (persisted && attempt.result === 'available') await unlink(recoverySnapshot(path, target.date)).catch(() => {})
    log({ event: 'krx-collection', endpoint: path, date: attempt.date, at: attempt.at,
      result: published.attempt.result, code: published.attempt.code, latestDate: published.data?.date ?? null,
      collectedAt: published.data?.collectedAt ?? null, persisted })
    return published
  }

  async function load(path, target = targetFor()) {
    if (scheduledOnly) return readState(path)
    if (!key?.trim()) return readState(path)
    if (!pending.has(path)) pending.set(path, exclusive(() => {
      states.delete(path)
      return refresh(path, target)
    }).finally(() => pending.delete(path)))
    return pending.get(path)
  }

  function metadata(state, target) {
    const current = Boolean(state.data?.date >= target.date)
    const reason = !key?.trim() ? 'provider-not-configured'
      : scheduledOnly && !target.known ? 'provider-not-configured'
        : target.closed ? 'weekend'
          : current ? (target.weekend ? 'weekend' : target.beforeClose ? 'before-collection' : null)
        : state.attempt?.date === target.date && state.attempt?.result === 'error' ? 'provider-error' : 'not-published'
    return { status: !state.data ? 'unavailable' : current ? 'available' : 'stale',
      reason, collectedAt: state.data?.collectedAt ?? null, source,
      lastAttemptAt: state.attempt?.at ?? null, usingPreviousClose: Boolean(state.data && !current),
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
    const [listing] = matches
    const { market, listedOn, fullName, shareClass } = listing
    const trades = await load(endpoint[market].trades, target)
    const latest = trades.data ?? null
    const latestDate = latest?.date ?? null
    const latestQuote = latest?.rows.find(row => row.symbol === symbol && row.tradingDate >= listedOn) ?? null
    const bars = []
    let stoppedAt = null
    let stoppedReason = null
    for (const date of latestDate ? tradingCandidates(latestDate, historyClosed) : []) {
      if (bars.length >= historySessions) break
      if (date < listedOn) break
      const cached = date === latestDate
        ? { rows: latest.rows.map(toBar).filter(Boolean) }
        : await readHistory(market, date)
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
    const { reason, errorCode, lastAttemptAt, usingPreviousClose } = metadata(trades, target)
    return { symbol, name: listingDisplayName(symbol, listing), fullName, shareClass, market, source,
      quote: latestQuote, reason, errorCode,
      latestDate, collectedAt: latest?.collectedAt ?? null, lastAttemptAt, usingPreviousClose, stoppedAt, stoppedReason,
      afterHours: afterHours(target),
      history: { currency: 'KRW', timeZone: 'Asia/Seoul', adjustment: 'unadjusted',
        completeness: bars.length ? 'complete' : 'missing-observations', bars: bars.reverse() } }
  }

  function checkBatch(limit) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 145) throw new Error('Invalid KRX backfill configuration')
  }

  async function backfillPlan(limit = 140) {
    checkBatch(limit)
    const target = targetFor()
    const results = {}
    for (const market of markets) {
      let cachedSessions = 0, marketEmptyDays = 0, missingWeekdays = 0
      for (const date of tradingCandidates(target.date, historyClosed)) {
        const cached = await readHistory(market, date)
        if (!cached) missingWeekdays++
        else if (cached.rows.length) cachedSessions++
        else marketEmptyDays++
        if (cachedSessions === historySessions) break
      }
      results[market] = { cachedSessions, marketEmptyDays, missingWeekdays,
        targetSessions: historySessions, minimumAdditionalSessions: historySessions - cachedSessions, requestCap: limit }
    }
    return { targetDate: target.date, latestLookupMax: 16, maxRequestsPerRun: Math.min(300, 2 * limit + 16), markets: results }
  }

  let backfillPending
  async function runBackfill(limit) {
    checkBatch(limit)
    if (!key?.trim()) throw new Error('Invalid KRX backfill configuration')
    const target = targetFor()
    if (clock() < ledger.blockedUntil) throw new ProviderError(503, 'PROVIDER_RATE_LIMITED')
    const results = {}
    for (const market of markets) {
      const path = endpoint[market].trades
      states.delete(path)
      const state = scheduledOnly ? await readState(path) : await refresh(path, target)
      if (state.attempt?.date === target.date && backfillStopCodes.has(state.attempt.code)) {
        throw new ProviderError(503, state.attempt.code)
      }
      const latest = state.data
      if (!latest) throw new Error('Latest KRX trading date unavailable')
      const result = { requested: 0, sessions: 0, empty: 0, failures: [], oldest: latest.date, latest: latest.date }
      let availableSessions = 0
      for (const date of tradingCandidates(latest.date, historyClosed)) {
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

  const indexFile = (market, date) => join(root, 'index-' + market + '-' + date + '.json')

  async function planMissing({ target, dates, selectedMarkets = markets, kinds = ['trades', 'index'], automatic = false }) {
    if (!Array.isArray(selectedMarkets) || !selectedMarkets.length ||
        !selectedMarkets.every(market => markets.includes(market)) ||
        !Array.isArray(kinds) || !kinds.length || !kinds.every(kind => ['trades', 'index'].includes(kind)) ||
        (dates !== undefined && (!Array.isArray(dates) || dates.length > 30 || !dates.every(isDay)))) {
      throw new ProviderError(400, 'KRX_INVALID_RECOVERY_PLAN')
    }
    const beforeMorning = clock() < target.recoveryStartsAt
    const candidates = [...tradingCandidates(target.today, calendar.closed)]
      .filter(date => date < target.today && calendar.known(date))
    if (!target.closed && (beforeMorning || automatic)) candidates.shift()
    const eligible = new Set(candidates)
    const requested = dates === undefined ? candidates.slice(0, recoveryLookback) : [...new Set(dates)]
    const deferredDates = requested.filter(date => !eligible.has(date))
    const saved = await readJson(recoveryFile)
    if (saved !== undefined && (!saved || typeof saved !== 'object' || Array.isArray(saved))) {
      throw new ProviderError(503, 'KRX_HISTORY_CACHE_FAILED')
    }
    const journal = Object.fromEntries(Object.entries(saved ?? {})
      .filter(([, attempt]) => Date.parse(attempt?.at) > clock() - 90 * dayMs))
    const tasks = []
    for (const market of new Set(selectedMarkets)) {
      for (const kind of new Set(kinds)) {
        const path = endpoint[market][kind]
        const state = await readSnapshot(path)
        const recorded = new Set(state.history.filter(attempt => attempt.result === 'available').map(attempt => attempt.date))
        const observed = [state.data?.date, ...recorded].filter(Boolean).sort()[0]
        let oldest = observed
        const availability = new Map()
        for (const date of requested.filter(date => eligible.has(date))) {
          if (kind === 'trades') {
            const cached = await readHistory(market, date)
            availability.set(date, Boolean(cached?.rows.length))
            if (cached?.rows.length && (!oldest || date < oldest)) oldest = date
          } else {
            const cached = await readFile(indexFile(market, date), 'utf8').then(JSON.parse).catch(() => null)
            const row = cached?.row
            availability.set(date, state.data?.date === date || state.previousData?.date === date || recorded.has(date) ||
              (row?.tradingDate === date && row.indexClass === market && row.indexName === endpoint[market].name &&
                Number.isFinite(row.price) && row.price > 0))
            if (availability.get(date) && (!oldest || date < oldest)) oldest = date
          }
        }
        for (const [date, available] of availability) {
          if (available || (dates === undefined && (!oldest || date < oldest))) continue
          const id = path + ':' + date
          const previous = [journal[id], ...state.history, state.attempt]
            .filter(attempt => attempt && (attempt === journal[id] || attempt.date === date))
            .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0]
          const snapshot = [state.data, state.previousData].find(value => value?.date === date)
          const snapshotRows = kind === 'trades' ? snapshot?.rows : undefined
          const recentlyAttempted = !snapshotRows && previous && Date.parse(previous.at) > clock() - 20 * 3_600_000
          tasks.push({ market, kind, date, path, id, snapshotRows, previous,
            status: recentlyAttempted ? 'retry-pending' : 'missing' })
        }
      }
    }
    tasks.sort((a, b) => (Date.parse(a.previous?.at) || 0) - (Date.parse(b.previous?.at) || 0) ||
      a.date.localeCompare(b.date))
    return { tasks, deferredDates, journal }
  }

  async function recoverMissing({ target, dates, markets: selectedMarkets, kinds, dryRun = false, signal, automatic = false }) {
    const { tasks, deferredDates, journal } = await planMissing({
      target, dates, selectedMarkets, kinds, automatic,
    })
    const latestEligible = krxCollectionSession(target.recoveryStartsAt, calendar).date
    const batch = tasks.filter(task => task.status === 'missing').slice(0, recoveryLimit)
    const budget = dryRun ? await readLedger() : ledger
    const result = {
      dryRun, deferredDates, maxRequests: batch.filter(task => !task.snapshotRows).length,
      remainingRequests: remainingRequests(budget),
      cooldownUntil: budget.blockedUntil > clock() ? new Date(budget.blockedUntil).toISOString() : null,
      targets: tasks.map(({ market, kind, date, snapshotRows, status, previous }) =>
        ({ market, kind, date, status, needsRequest: !snapshotRows,
          lastAttempt: previous ? { at: previous.at, status: previous.status ?? previous.result, code: previous.code } : null,
        })),
      attempts: 0, outcomes: [],
    }
    if (dryRun || !batch.length) return result
    if (!key?.trim()) throw new ProviderError(503, 'KRX_NOT_CONFIGURED')
    const persist = async () => {
      if (!(await save(recoveryFile, journal))) throw new ProviderError(503, 'KRX_HISTORY_CACHE_FAILED')
    }
    for (const task of batch) {
      if (signal?.aborted) break
      const { market, kind, date, path, id, snapshotRows } = task
      if (!snapshotRows && (clock() < ledger.blockedUntil || remainingRequests() <= 0)) {
        result.stopped = 'PROVIDER_RATE_LIMITED'
        break
      }
      const outcome = { market, kind, date, at: new Date(clock()).toISOString(), status: 'retry-pending' }
      journal[id] = outcome
      await persist()
      const requests = []
      try {
        const rows = snapshotRows ?? await request(path, date, { requests })
        if (!rows.length) outcome.status = 'not-published'
        else {
          if (!automatic && !snapshotRows && date === latestEligible &&
              !(await save(recoverySnapshot(path, date), { date, rows }))) {
            throw new ProviderError(503, 'KRX_HISTORY_CACHE_FAILED')
          }
          if (kind === 'trades') await saveHistory(market, date, rows)
          else if (!(await save(indexFile(market, date), { row: rows[0] }))) {
            throw new ProviderError(503, 'KRX_HISTORY_CACHE_FAILED')
          }
          outcome.status = 'available'
        }
      } catch (error) {
        outcome.code = error.code ?? 'KRX_UNAVAILABLE'
        outcome.status = outcome.code === 'PROVIDER_RATE_LIMITED' ? 'rate-limited' : 'error'
        if (backfillStopCodes.has(outcome.code)) result.stopped = outcome.code
      }
      result.attempts += requests.length
      outcome.requests = requests
      result.outcomes.push(outcome)
      await persist()
      if (result.stopped) break
    }
    log({ event: 'krx-recovery', ...result })
    return result
  }

  async function overview() {
    const target = targetFor()
    const latest = await Promise.all(markets.map(market => load(endpoint[market].trades, target)))
    const snapshots = latest.map(state => [state.data, state.previousData].filter(Boolean))
    const date = snapshots[0].find(data => snapshots[1].some(other => other.date === data.date))?.date
    const datasets = latest.map((state, index) => ({ ...state, data: snapshots[index].find(data => data.date === date) }))
    const lastAttemptAt = latest.map(state => state.attempt?.at).filter(Boolean).sort().at(-1) ?? null
    if (!date || datasets.some(state => state.data?.date !== date)) {
      const reasons = datasets.map(state => metadata(state, target).reason)
      const reason = ['provider-not-configured', 'provider-error'].find(value => reasons.includes(value))
        ?? 'same-date-data-unavailable'
      return { source, tradingDate: null, collectedAt: null, reason, lastAttemptAt, usingPreviousClose: false,
        leaders: null, tiles: [], marketTiles: { KOSPI: [], KOSDAQ: [] } }
    }
    const catalogs = await Promise.all(markets.map(market => load(endpoint[market].listings, target)))
    const rows = datasets.flatMap((state, index) => {
      const market = markets[index]
      const { data, previousData } = catalogs[index]
      const current = new Map(data?.rows.map(row => [row.symbol, row]))
      const previous = new Map(previousData?.rows.map(row => [row.symbol, row]))
      const eligible = state.data.rows.filter(row => row.volume > 0)
      let mapped = 0
      let named = 0
      const result = eligible.map(trade => {
        const { symbol, name: rawName, price, changePercent, volume, turnover, marketCap } = trade
        const candidate = current.get(symbol)
        const prior = previous.get(symbol)
        const priorApplies = date < data?.date && date >= previousData?.date &&
          matchesTrade(prior, trade, previousData.date, date)
        const sameIssue = priorApplies && candidate && candidate.listedOn === prior.listedOn &&
          /^[A-Z]{2}[A-Z0-9]{9}\d$/.test(prior.isin) && candidate.isin === prior.isin
        const conflictingIssue = priorApplies && prior.isin && candidate?.isin && prior.isin !== candidate.isin
        const listing = sameIssue || (!conflictingIssue && matchesTrade(candidate, trade, data?.date, date)) ? candidate
          : priorApplies ? prior : undefined
        const name = listingDisplayName(symbol, listing, rawName)
        if (listing) mapped++
        if (name !== symbol) named++
        return { symbol, name, shortName: name, rawName, fullName: listing?.fullName, shareClass: listing?.shareClass,
          mapped: Boolean(listing), market, price, changePercent, volume, turnover: turnover ?? null, marketCap }
      })
      const signature = JSON.stringify([date, state.data.collectedAt, data?.date, data?.collectedAt, previousData?.date])
      if (mappingReported.get(market) !== signature) {
        mappingReported.set(market, signature)
        log({ event: 'krx-name-mapping', market, tradingDate: date, listingDate: data?.date ?? null,
          total: eligible.length, mapped, failed: eligible.length - mapped,
          mappingRate: eligible.length ? mapped / eligible.length : null, named, codeOnly: eligible.length - named })
      }
      return result
    })
    const top = (field, direction, filter = () => true) => rows.filter(filter)
      .sort((a, b) => direction * (a[field] - b[field]) || a.symbol.localeCompare(b.symbol))
    const tiles = top('marketCap', -1, row => row.marketCap > 0 && Number.isFinite(row.changePercent))
    return { source, tradingDate: date, lastAttemptAt, usingPreviousClose: date < target.date, collectedAt: datasets.map(state => state.data.collectedAt).sort().at(-1),
      reason: datasets.map(state => metadata(state, target).reason).find(Boolean) ?? null,
      leaders: {
        advances: top('changePercent', -1, row => row.changePercent > 0).slice(0, 5),
        declines: top('changePercent', 1, row => row.changePercent < 0).slice(0, 5),
        volume: top('volume', -1).slice(0, 5),
        turnover: top('turnover', -1, row => row.turnover > 0).slice(0, 5),
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

  function afterCheckDue(target) {
    return scheduledOnly && !target.closed && target.known && afterCheck?.date !== target.today &&
      clock() >= Date.parse(target.afterCheckAt)
  }

  async function runCollection(signal) {
    if (signal?.aborted) return
    const target = targetFor()
    if (afterCheckDue(target)) {
      // No authorized after-hours price adapter is configured. Record only the
      // connection check, never a price observation or a provider call.
      const saved = await readFile(afterCheckFile, 'utf8').then(JSON.parse).catch(() => null)
      if (saved?.date === target.today && Number.isFinite(Date.parse(saved.at))) afterCheck = saved
      else {
        afterCheck = { date: target.today, at: new Date(clock()).toISOString() }
        await save(afterCheckFile, afterCheck)
      }
    }
    if (!key?.trim() || (scheduledOnly && (!target.canCollect || completedSlot === target.slotStart))) return
    if (clock() < ledger.blockedUntil || remainingRequests() <= 0) return
    let recoveryAllowed = true
    for (const path of services) {
      if (signal?.aborted) return
      states.delete(path)
      const state = await refresh(path, target)
      if (state.attempt?.date === target.date && backfillStopCodes.has(state.attempt.code)) {
        recoveryAllowed = false
      }
      if (clock() < ledger.blockedUntil || remainingRequests() <= 0) return
    }
    if (scheduledOnly && recoveryAllowed && target.recoveryWindow && !signal?.aborted) {
      if ((await readJson(recoveryWindowFile))?.date !== target.today) {
        if (!(await save(recoveryWindowFile, { date: target.today }))) {
          throw new ProviderError(503, 'KRX_HISTORY_CACHE_FAILED')
        }
        await recoverMissing({ target, signal, automatic: true })
      }
    }
    if (scheduledOnly) completedSlot = target.slotStart
  }

  return {
    stockHistory(symbol) {
      if (!historyPending.has(symbol)) historyPending.set(symbol, stockHistory(symbol).finally(() => historyPending.delete(symbol)))
      return historyPending.get(symbol)
    },
    backfillPlan,
    backfillMissingDates({ dryRun = true, ...options } = {}) {
      const recover = () => recoverMissing({
        ...options, dryRun, target: krxCollectionSession(clock(), calendar),
      })
      return dryRun ? recover() : exclusive(recover)
    },
    backfill(limit = 140) {
      checkBatch(limit)
      if (backfillPending) throw new ProviderError(503, 'KRX_BACKFILL_BUSY')
      backfillPending = exclusive(() => runBackfill(limit)).finally(() => { backfillPending = undefined })
      return backfillPending
    },
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
      return { market, listings: metadata(listings, target),
        trades: { ...metadata(trades, target), tradingDate: trades.data?.date ?? null },
        afterHours: afterHours(target),
        listingDate: listings.data?.date ?? null, items: matches.slice(0, 20).map(row => ({
          ...row, name: listingDisplayName(row.symbol, row),
          quote: trades.data && row.listedOn <= trades.data.date
            ? byCode.get(row.symbol) ?? null : null,
        })) }
    },
    async collect(signal) {
      const target = targetFor()
      if (scheduledOnly && !afterCheckDue(target) &&
          (!key?.trim() || !target.canCollect || completedSlot === target.slotStart)) return
      collection ??= exclusive(() => runCollection(signal)).catch(error => {
        if (error.code !== 'KRX_BACKFILL_BUSY') throw error
      }).finally(() => { collection = undefined })
      return collection
    },
  }
}
