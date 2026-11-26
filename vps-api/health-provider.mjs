import { performance } from 'node:perf_hooks'
import { krxCollectionEndpoints } from './krx-provider.mjs'
import { isDay, ProviderError, healthMetadata } from './public-provider.mjs'

const providers = ['krx', 'fx', 'ecos', 'dart', 'yfinance', 'kr-intraday']
const incidentStatuses = new Set(['Degraded', 'Stale', 'Unavailable', 'Rate Limited'])
const usIndices = new Set(['^GSPC', '^IXIC', '^DJI'])
const usStockLimit = 64
const idle = 'Not Yet Collected'
const codePattern = /^(?:PROVIDER_|KRX_|FX_|ECOS_|DART_|US_)[A-Z0-9_]{1,48}$/
const safeCode = value => typeof value === 'string' && codePattern.test(value) ? value : null
const limited = code => code === 'DART_PROVIDER_LIMITED' || code?.endsWith('RATE_LIMITED')
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null

function resultStatus(data, error, configured, refreshFailed = false) {
  if (!configured || error?.endsWith('CONFIGURATION_MISSING') || data?.reason === 'provider-not-configured') return 'Not Configured'
  if (limited(error) || limited(safeCode(data?.filingsError)) || limited(safeCode(data?.financialsError)) || data?.reason === 'rate-limited'
    || data?.indicators?.some(item => limited(safeCode(item.code)))) return 'Rate Limited'
  if (error || refreshFailed || data?.reason === 'provider-error') {
    return data?.tradingDate || data?.reference?.observationDate || data?.collectedAt ? 'Stale' : 'Unavailable'
  }
  if (data?.filingsError || data?.financialsError || data?.indicators?.some(item => item.status === 'unavailable' && safeCode(item.code))) return 'Degraded'
  // A scheduled collection window or closed market can legitimately have no fresh observation.
  if (data?.status === 'stale') return 'Stale'
  if (data?.status === 'unavailable') return ['collecting', 'not-published', 'weekend', 'before-collection'].includes(data.reason)
    ? idle : 'Unavailable'
  if (data?.usingPreviousClose && !['weekend', 'before-collection', 'not-published'].includes(data.reason)) return 'Stale'
  return 'Healthy'
}

export function createProviderHealth({ configured = {}, clock = Date.now, alertDelayMs = 120_000 } = {}) {
  const rows = new Map(providers.map(provider => [provider, {
    provider, status: configured[provider] === false ? 'Not Configured' : idle,
    attemptedAt: null, succeededAt: null, observationDate: null, responseMs: null, httpStatus: null,
    errorCode: null, usedCache: null, retries: 0, consecutiveFailures: 0,
  }]))
  const incidents = new Map()
  const events = []
  const krxEndpoints = new Map()
  const usIndexObservations = new Map()
  const usStockObservations = new Map()
  const severity = [idle, 'Healthy', 'Not Configured', 'Degraded', 'Stale', 'Unavailable', 'Rate Limited']

  function record(provider, status, fields, countFailure = true) {
    const previous = rows.get(provider)
    if (!previous) return
    const now = clock()
    const at = new Date(now).toISOString()
    const failed = incidentStatuses.has(status)
    const incident = incidents.get(provider)
    if (failed) {
      if (!incident && countFailure) incidents.set(provider, { start: now, notified: false })
      else if (incident && countFailure && !incident.notified && now - incident.start >= alertDelayMs) {
        incident.notified = true
        events.push({ provider, at, kind: 'incident', status })
      }
    } else if (status !== idle) {
      if (incident?.notified && status === 'Healthy') events.push({ provider, at, kind: 'recovery', status })
      incidents.delete(provider)
    }
    if (events.length > 20) events.shift()
    rows.set(provider, { ...previous, ...fields, status, attemptedAt: fields.attemptedAt ?? at,
      succeededAt: [previous.succeededAt, fields.succeededAt].filter(Boolean).sort().at(-1) ?? null,
      observationDate: fields.observationDate ?? previous.observationDate,
      consecutiveFailures: failed ? previous.consecutiveFailures + Number(countFailure) : status === idle ? previous.consecutiveFailures : 0 })
  }

  function recordResult(provider, data, error, responseMs, scope) {
    if (provider === 'dart' && error instanceof ProviderError && error.statusCode === 404 && error.code === 'COMPANY_NOT_FOUND') return
    if (provider === 'yfinance' && data?.reason === 'unsupported') return
    const metadata = data?.[healthMetadata] ?? error?.[healthMetadata]
    const detail = data?.reference ?? data
    const errorCode = safeCode(data?.refreshError) ?? (error instanceof ProviderError ? safeCode(error.code) : null)
    const status = error && !errorCode ? 'Unavailable' : resultStatus(data, errorCode, configured[provider] !== false, Boolean(data?.refreshError))
    const published = provider === 'ecos' ? (data?.indicators ?? []).filter(item => item.status === 'published') : []
    const newest = values => values.filter(Boolean).sort().at(-1)
    const date = detail?.observationDate ?? data?.tradingDate ?? data?.quote?.tradingDate ?? data?.latestDate
      ?? newest(published.map(item => isDay(item.observationDate) ? item.observationDate : null))
      ?? (provider === 'dart' && newest((data?.filings ?? []).map(item => isDay(item.filedAt) ? item.filedAt : null)))
    const succeededAt = timestamp(detail?.collectedAt) ?? newest(published.map(item => timestamp(item.collectedAt)))
      ?? (provider === 'dart' && status === 'Healthy' && metadata?.attempted !== false ? new Date(clock()).toISOString() : null)
    const fields = {
      attemptedAt: timestamp(metadata?.attemptedAt), succeededAt, observationDate: isDay(date) ? date : null,
      responseMs, httpStatus: error ? error.statusCode ?? 500 : 200,
      errorCode: errorCode ?? safeCode(data?.filingsError) ?? safeCode(data?.financialsError)
        ?? (provider === 'ecos' ? (data?.indicators ?? []).map(item => safeCode(item.code)).find(Boolean) : null),
      usedCache: metadata?.usedCache ?? (data?.usingPreviousClose === true || Boolean(data?.refreshError)
        || data?.status === 'stale' || (provider === 'yfinance' && Boolean(data?.collectedAt)) ? true : null),
      retries: metadata?.retries ?? 0,
    }
    if (provider !== 'yfinance') {
      record(provider, status, fields, metadata?.attempted !== false)
      return
    }
    const observations = usIndices.has(scope) ? usIndexObservations : usStockObservations
    const key = typeof scope === 'string' && (usIndices.has(scope) || /^[A-Z][A-Z0-9]{0,9}(?:-[A-Z0-9]{1,5})?$/.test(scope))
      ? scope : 'other'
    const before = observations.get(key)
    if (status === idle && before) return
    if (observations === usStockObservations && !before && observations.size >= usStockLimit) {
      const replaceable = [...observations].find(([, observation]) => !incidentStatuses.has(observation.status))
      // Healthy reads cannot displace the only evidence of an active incident.
      if (!replaceable && !incidentStatuses.has(status)) return
      observations.delete(replaceable?.[0] ?? observations.keys().next().value)
    }
    observations.delete(key)
    observations.set(key, { status, fields })
    const worst = [...usIndexObservations.values(), ...usStockObservations.values()].reduce((a, b) =>
      severity.indexOf(a.status) > severity.indexOf(b.status) ? a : b)
    record(provider, worst.status, { ...worst.fields, succeededAt: fields.succeededAt },
      incidentStatuses.has(status) && ((!fields.attemptedAt && !fields.observationDate)
        || before?.status !== status || before?.fields.observationDate !== fields.observationDate
        || before?.fields.attemptedAt !== fields.attemptedAt))
  }

  return {
    async observe(provider, load, scope) {
      const start = performance.now()
      try {
        const result = await load()
        recordResult(provider, result, null, Math.round(performance.now() - start), scope)
        return result
      } catch (error) {
        recordResult(provider, null, error, Math.round(performance.now() - start), scope)
        throw error
      }
    },
    krx(entry) {
      if (entry.event !== 'krx-collection' || !krxCollectionEndpoints.includes(entry.endpoint)) return
      const code = safeCode(entry.code)
      const previous = krxEndpoints.get(entry.endpoint)
      const missing = entry.result === 'empty' || entry.result === 'fallback'
      const status = entry.result === 'error'
        ? resultStatus({ tradingDate: entry.latestDate }, code ?? 'KRX_UNAVAILABLE', true)
        : missing && !entry.pendingPublication ? entry.latestDate ? 'Stale' : 'Unavailable'
          : missing ? previous?.status ?? idle : 'Healthy'
      krxEndpoints.set(entry.endpoint, { status, entry, code: code ?? (missing && entry.pendingPublication ? previous?.code : null) })
      const worst = [...krxEndpoints.values()].reduce((a, b) =>
        severity.indexOf(a.status) > severity.indexOf(b.status) ? a : b)
      const latest = worst.entry
      record('krx', worst.status, {
        attemptedAt: timestamp(entry.at), succeededAt: timestamp(entry.collectedAt), errorCode: worst.code,
        observationDate: isDay(latest.latestDate) ? latest.latestDate : null, usedCache: latest.result !== 'available' && isDay(latest.latestDate),
        responseMs: Number.isFinite(latest.elapsedMs) ? latest.elapsedMs : null,
        httpStatus: Number.isInteger(latest.httpStatus) ? latest.httpStatus : null,
        retries: Number.isInteger(latest.retries) ? latest.retries : 0,
      }, incidentStatuses.has(status) && !(missing && entry.pendingPublication))
    },
    snapshot() {
      return { providers: [...rows.values()], alerts: { mode: 'test', events: [...events] } }
    },
  }
}
