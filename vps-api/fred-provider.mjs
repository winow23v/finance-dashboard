import { performance } from 'node:perf_hooks'

const board = 'Board of Governors of the Federal Reserve System (US)'
const bls = 'U.S. Bureau of Labor Statistics'
const series = [
  { id: 'DFEDTARU', name: '미국 기준금리 목표 상단', agency: board, frequency: 'D', staleDays: 3 },
  { id: 'DGS10', name: '미국 10년물 국채금리', agency: board, frequency: 'D', staleDays: 7 },
  { id: 'CPIAUCSL', name: '미국 소비자물가지수 (계절조정)', agency: bls, frequency: 'M', staleDays: 62 },
  { id: 'UNRATE', name: '미국 실업률 (계절조정)', agency: bls, frequency: 'M', staleDays: 62 },
  { id: 'DGS2', name: '미국 2년물 국채금리', agency: board, frequency: 'D', staleDays: 7 },
  { id: 'FEDFUNDS', name: '미국 연방기금금리', agency: board, frequency: 'M', staleDays: 62 },
]

export const fredSeriesIds = series.map(({ id }) => id)

const dayMs = 86_400_000
const maxBytes = 64 * 1024

export class FredError extends Error {
  constructor(statusCode, code = statusCode === 503 ? 'FRED_UNAVAILABLE' : 'FRED_UPSTREAM_ERROR') {
    super(statusCode === 503 ? 'FRED temporarily unavailable' : 'Invalid or failed FRED response')
    this.statusCode = statusCode
    this.code = code
  }
}

function isDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const time = Date.parse(value)
  return Number.isFinite(time) && new Date(time).toISOString().startsWith(value + 'T')
}

async function readFredResponse(response) {
  if (response.ok) return readJson(response)
  if (response.status === 400) {
    const body = await readJson(response).catch(() => null)
    if (typeof body?.error_message === 'string' && /\bapi_key\b/i.test(body.error_message)) {
      throw new FredError(502, 'FRED_AUTH_REJECTED')
    }
    throw new FredError(502)
  }
  if (response.body) void response.body.cancel().catch(() => {})
  if ([401, 403, 423].includes(response.status)) throw new FredError(502, 'FRED_ACCESS_DENIED')
  if (response.status === 429) throw new FredError(503, 'FRED_RATE_LIMITED')
  throw new FredError(response.status === 503 ? 503 : 502)
}

async function readJson(response) {
  if (!response.body || Number(response.headers.get('content-length')) > maxBytes) {
    if (response.body) void response.body.cancel().catch(() => {})
    throw new FredError(502)
  }
  const reader = response.body.getReader()
  const chunks = []
  let bytes = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > maxBytes) {
        void reader.cancel().catch(() => {})
        throw new FredError(502)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'))
}

function normalize(definition, metadata, observations, collectedAt) {
  const { id, name, agency, frequency, staleDays } = definition
  const cpi = id === 'CPIAUCSL'
  const info = metadata?.seriess?.[0]
  const rows = observations?.observations
  const expectedFrequency = info?.frequency_short === frequency ||
    (id === 'DFEDTARU' && info?.frequency === 'Daily, 7-Day')
  if (!Array.isArray(metadata?.seriess) || metadata.seriess.length !== 1 ||
    info?.id !== id || !expectedFrequency ||
    (cpi ? info.units !== 'Index 1982-1984=100' : info.units !== 'Percent') ||
    !Array.isArray(rows) || rows.length > (cpi ? 24 : 14)) throw new FredError(502)

  const values = new Map()
  for (const row of rows) {
    const { date, value } = row ?? {}
    if (!isDate(date) || (frequency === 'M' && !date.endsWith('-01')) || values.has(date) ||
      typeof value !== 'string' || (value !== '.' && !/^[+-]?\d+(?:\.\d+)?$/.test(value))) {
      throw new FredError(502)
    }
    const numeric = value === '.' ? null : Number(value)
    if (numeric !== null && (!Number.isFinite(numeric) || (cpi && numeric <= 0))) throw new FredError(502)
    values.set(date, numeric)
  }

  const dates = [...values.keys()].sort().reverse()
  const validDates = dates.filter(date => values.get(date) !== null)
  // Preserve the latest reported period for unemployment, including an explicit missing value.
  const observationDate = (id === 'UNRATE' ? dates[0] : validDates[0]) ?? null
  const value = values.get(observationDate) ?? null
  const previousDate = value === null ? null : frequency === 'D' ? validDates[1] ?? null :
    new Date(Date.parse(observationDate) - dayMs).toISOString().slice(0, 7) + '-01'
  const previousValue = values.get(previousDate)
  const source = { name: 'FRED', agency, url: `https://fred.stlouisfed.org/series/${id}` }
  const common = {
    seriesId: id, releaseDate: null, collectedAt, source,
    frequency: id === 'DFEDTARU' ? 'daily-7-day' : frequency === 'D' ? 'daily' : 'monthly',
  }
  function indicator(id, name, unit, value, date = observationDate) {
    return {
      ...common, id, name, unit, value, observationDate: date,
      stale: value === null ? null : Date.parse(collectedAt) - Date.parse(date) >= staleDays * dayMs,
    }
  }
  const result = [{
    ...indicator(id, name, cpi ? 'index' : '%', value),
    previousObservationDate: previousValue == null ? null : previousDate,
    change: value === null || previousValue == null ? null : value - previousValue,
  }]
  if (cpi) {
    const currentDate = dates[0] ?? null
    const currentValue = values.get(currentDate) ?? null
    const comparisonPeriod = currentDate === null ? null :
      `${String(Number(currentDate.slice(0, 4)) - 1).padStart(4, '0')}${currentDate.slice(4)}`
    const previous = values.get(comparisonPeriod)
    const change = currentValue !== null && previous != null ? ((currentValue - previous) / previous) * 100 : null
    result.push({
      ...indicator('CPIAUCSL_YOY', '미국 소비자물가 상승률 (전년 동월 대비, 계절조정)', '%',
        Number.isFinite(change) ? change : null, currentDate),
      comparisonPeriod,
      missingReason: currentValue === null ? 'CURRENT_MISSING' : previous == null ? 'COMPARISON_MISSING' : null,
    })
  }
  return result
}

export function createFredProvider({
  fetchImpl = fetch,
  now = () => new Date(),
  timeoutMs = 5000,
  clock = () => performance.now(),
  maxBatchesPerMinute = 8,
  enabledSeries = fredSeriesIds,
  cacheMs = 0,
} = {}) {
  const selectedSeries = series.filter(({ id }) => enabledSeries.includes(id))
  if (!selectedSeries.length) throw new Error('No FRED series configured')
  let cached
  let pending
  let draining = false
  const started = []

  async function load(apiKey) {
    const controller = new AbortController()
    const { signal } = controller
    let timer
    async function request(path, id, params) {
      const url = new URL(path, 'https://api.stlouisfed.org')
      url.search = new URLSearchParams({ series_id: id, api_key: apiKey, file_type: 'json', ...params })
      return readFredResponse(await fetchImpl(url, { signal, redirect: 'error', cache: 'no-store' }))
    }

    try {
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new FredError(503, 'FRED_TIMEOUT'))
          controller.abort()
        }, timeoutMs)
      })
      const requests = selectedSeries.map(({ id }) => [
        request('/fred/series', id),
        request('/fred/series/observations', id, { sort_order: 'desc', limit: id === 'CPIAUCSL' ? '24' : '14' }),
      ])
      draining = true
      void Promise.allSettled(requests.flat()).then(() => { draining = false })
      const data = await Promise.race([timeout, Promise.all(requests.map(pair => Promise.all(pair)))])
      const collectedAt = now().toISOString()
      return {
        source: { label: 'FRED', simulated: false },
        indicators: selectedSeries.flatMap((definition, index) => normalize(definition, ...data[index], collectedAt)),
      }
    } catch (error) {
      if (error instanceof FredError) throw error
      throw new FredError(502)
    } finally {
      clearTimeout(timer)
      controller.abort()
    }
  }

  return function getIndicators() {
    const apiKey = process.env.FRED_API_KEY?.trim()
    if (!apiKey) throw new FredError(503, 'FRED_CONFIGURATION_MISSING')
    if (pending) return pending
    const time = clock()
    if (cached && cached.expires > time) return cached.data
    while (started.length && time - started[0] >= 60_000) started.shift()
    if (draining || started.length >= maxBatchesPerMinute) throw new FredError(503)
    started.push(time)
    pending = load(apiKey).then(data => {
      if (cacheMs > 0) cached = { data, expires: clock() + cacheMs }
      return data
    }).finally(() => { pending = undefined })
    return pending
  }
}


export function configureMemberFred({ configuredSeries = process.env.FRED_MEMBER_SERIES, ...options } = {}) {
  // An explicitly empty value disables member FRED. Unset uses the supported series.
  const enabledSeries = configuredSeries === undefined ? fredSeriesIds
    : configuredSeries.split(',').map(id => id.trim()).filter(Boolean)
  if (new Set(enabledSeries).size !== enabledSeries.length || enabledSeries.some(id => !fredSeriesIds.includes(id))) {
    throw new Error('Invalid FRED member series configuration')
  }
  return enabledSeries.length ? createFredProvider({ cacheMs: 5 * 60_000, ...options, enabledSeries }) : undefined
}
