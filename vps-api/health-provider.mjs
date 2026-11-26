import { performance } from 'node:perf_hooks'
import { isDay, ProviderError } from './public-provider.mjs'

const providers = ['krx', 'fx', 'ecos', 'dart', 'yfinance', 'kr-intraday']
const incidentStatuses = new Set(['Degraded', 'Stale', 'Unavailable', 'Rate Limited'])
const codePattern = /^(?:PROVIDER_|KRX_|FX_|ECOS_|DART_|US_)[A-Z0-9_]{1,48}$/
const safeCode = value => typeof value === 'string' && codePattern.test(value) ? value : null
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null

function resultStatus(data, error, configured) {
  if (!configured || error?.endsWith('CONFIGURATION_MISSING') || data?.reason === 'provider-not-configured') return 'Not Configured'
  if (error?.endsWith('RATE_LIMITED') || data?.reason === 'rate-limited') return 'Rate Limited'
  if (error || data?.reason === 'provider-error') {
    return data?.tradingDate || data?.reference?.observationDate || data?.collectedAt ? 'Stale' : 'Unavailable'
  }
  if (data?.filingsError || data?.financialsError || data?.indicators?.some(item => item.status === 'unavailable' && safeCode(item.code))) return 'Degraded'
  // A scheduled collection window or closed market can legitimately have no fresh observation.
  if (data?.status === 'unavailable' && !['collecting', 'not-published', 'weekend', 'before-collection'].includes(data.reason)) return 'Unavailable'
  if (data?.usingPreviousClose && !['weekend', 'before-collection', 'not-published'].includes(data.reason)) return 'Stale'
  return 'Healthy'
}

export function createProviderHealth({ configured = {}, clock = Date.now, alertDelayMs = 120_000 } = {}) {
  const rows = new Map(providers.map(provider => [provider, {
    provider, status: configured[provider] === false ? 'Not Configured' : 'Degraded',
    attemptedAt: null, succeededAt: null, observationDate: null, responseMs: null, httpStatus: null,
    errorCode: null, usedCache: null, retries: 0, consecutiveFailures: 0,
  }]))
  const incidents = new Map()
  const events = []
  const krxEndpoints = new Map()
  const severity = ['Healthy', 'Not Configured', 'Degraded', 'Stale', 'Unavailable', 'Rate Limited']

  function record(provider, status, fields) {
    const previous = rows.get(provider)
    if (!previous) return
    const now = clock()
    const at = new Date(now).toISOString()
    const failed = incidentStatuses.has(status)
    const incident = incidents.get(provider)
    if (failed) {
      if (!incident) incidents.set(provider, { start: now, notified: false })
      else if (!incident.notified && now - incident.start >= alertDelayMs) {
        incident.notified = true
        events.push({ provider, at, kind: 'incident', status })
      }
    } else {
      if (incident?.notified && status === 'Healthy') events.push({ provider, at, kind: 'recovery', status })
      incidents.delete(provider)
    }
    if (events.length > 20) events.shift()
    rows.set(provider, { ...previous, ...fields, status, attemptedAt: fields.attemptedAt ?? at,
      succeededAt: status === 'Healthy' ? (fields.succeededAt ?? previous.succeededAt) : previous.succeededAt,
      observationDate: fields.observationDate ?? previous.observationDate,
      consecutiveFailures: failed ? previous.consecutiveFailures + 1 : 0 })
  }

  function recordResult(provider, data, error, responseMs) {
    const detail = data?.reference ?? data
    const errorCode = safeCode(data?.refreshError) ?? (error instanceof ProviderError ? safeCode(error.code) : null)
    const status = error && !errorCode ? 'Unavailable' : resultStatus(data, errorCode, configured[provider] !== false)
    const published = provider === 'ecos' ? (data?.indicators ?? []).filter(item => item.status === 'published') : []
    const newest = values => values.filter(Boolean).sort().at(-1)
    const date = detail?.observationDate ?? data?.tradingDate ?? data?.quote?.tradingDate ?? data?.latestDate
      ?? newest(published.map(item => isDay(item.observationDate) ? item.observationDate : null))
      ?? (provider === 'dart' && newest((data?.filings ?? []).map(item => isDay(item.filedAt) ? item.filedAt : null)))
    const succeededAt = timestamp(detail?.collectedAt) ?? newest(published.map(item => timestamp(item.collectedAt)))
      ?? (provider === 'dart' && status === 'Healthy' ? new Date(clock()).toISOString() : null)
    record(provider, status, {
      succeededAt, observationDate: isDay(date) ? date : null,
      responseMs, httpStatus: error ? error.statusCode ?? 500 : 200,
      errorCode: errorCode ?? safeCode(data?.filingsError) ?? safeCode(data?.financialsError)
        ?? (provider === 'ecos' ? (data?.indicators ?? []).map(item => safeCode(item.code)).find(Boolean) : null),
      usedCache: data?.usingPreviousClose === true || Boolean(data?.refreshError) || data?.status === 'stale' ? true : null,
    })
  }

  return {
    async observe(provider, load) {
      const start = performance.now()
      try {
        const result = await load()
        recordResult(provider, result, null, Math.round(performance.now() - start))
        return result
      } catch (error) {
        recordResult(provider, null, error, Math.round(performance.now() - start))
        throw error
      }
    },
    krx(entry) {
      if (entry.event !== 'krx-collection') return
      const code = safeCode(entry.code)
      const status = entry.result === 'error'
        ? resultStatus({ tradingDate: entry.latestDate }, code ?? 'KRX_UNAVAILABLE', true) : 'Healthy'
      krxEndpoints.set(entry.endpoint, { status, entry, code })
      const worst = [...krxEndpoints.values()].reduce((a, b) =>
        severity.indexOf(a.status) > severity.indexOf(b.status) ? a : b)
      const latest = worst.entry
      record('krx', worst.status, {
        attemptedAt: timestamp(entry.at), succeededAt: timestamp(entry.collectedAt), errorCode: worst.code,
        observationDate: isDay(latest.latestDate) ? latest.latestDate : null, usedCache: latest.result !== 'available',
        responseMs: Number.isFinite(latest.elapsedMs) ? latest.elapsedMs : null,
        httpStatus: Number.isInteger(latest.httpStatus) ? latest.httpStatus : null,
        retries: Number.isInteger(latest.retries) ? latest.retries : 0,
      })
    },
    snapshot() {
      return { providers: [...rows.values()], alerts: { mode: 'test', events: [...events] } }
    },
  }
}
