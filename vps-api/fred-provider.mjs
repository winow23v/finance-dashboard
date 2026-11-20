import { performance } from 'node:perf_hooks'

const board = 'Board of Governors of the Federal Reserve System (US)'
const bls = 'U.S. Bureau of Labor Statistics'
const series = [
  { id: 'DFEDTARU', name: '미국 기준금리 목표 상단', agency: board, frequency: 'D', staleDays: 3 },
  { id: 'DGS10', name: '미국 10년물 국채금리', agency: board, frequency: 'D', staleDays: 7 },
  { id: 'CPIAUCSL', name: '미국 소비자물가지수 (계절조정)', agency: bls, frequency: 'M', staleDays: 62 },
  { id: 'UNRATE', name: '미국 실업률 (계절조정)', agency: bls, frequency: 'M', staleDays: 62 },
]

const dayMs = 86_400_000
const maxBytes = 64 * 1024

export class FredError extends Error {
  constructor(statusCode) {
    super(statusCode === 503 ? 'FRED temporarily unavailable' : 'Invalid or failed FRED response')
    this.statusCode = statusCode
  }
}

function isDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const time = Date.parse(value)
  return Number.isFinite(time) && new Date(time).toISOString().startsWith(value + 'T')
}

async function readJson(response) {
  if (!response.ok || !response.body || Number(response.headers.get('content-length')) > maxBytes) {
    if (response.body) void response.body.cancel().catch(() => {})
    throw new FredError(response.status === 429 || response.status === 503 ? 503 : 502)
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
  // Daily series can contain holiday placeholders. Monthly placeholders identify a missing period.
  const observationDate = (frequency === 'D' ? dates.find(date => values.get(date) !== null) : dates[0]) ?? null
  const value = values.get(observationDate) ?? null
  const source = { name: 'FRED', agency, url: `https://fred.stlouisfed.org/series/${id}` }
  const common = { seriesId: id, observationDate, releaseDate: null, collectedAt, source }
  function indicator(id, name, unit, value) {
    return {
      ...common, id, name, unit, value,
      stale: value === null ? null : Date.parse(collectedAt) - Date.parse(observationDate) >= staleDays * dayMs,
    }
  }
  const result = [indicator(id, name, cpi ? 'index' : '%', value)]
  if (cpi) {
    const comparisonPeriod = observationDate === null ? null :
      `${String(Number(observationDate.slice(0, 4)) - 1).padStart(4, '0')}${observationDate.slice(4)}`
    const previous = values.get(comparisonPeriod)
    const change = value !== null && previous != null ? ((value - previous) / previous) * 100 : null
    result.push({
      ...indicator('CPIAUCSL_YOY', '미국 소비자물가 상승률 (전년 동월 대비, 계절조정)', '%',
        Number.isFinite(change) ? change : null),
      comparisonPeriod,
      missingReason: value === null ? 'CURRENT_MISSING' : previous == null ? 'COMPARISON_MISSING' : null,
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
} = {}) {
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
      return readJson(await fetchImpl(url, { signal, redirect: 'error', cache: 'no-store' }))
    }

    try {
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new FredError(503))
          controller.abort()
        }, timeoutMs)
      })
      const requests = series.map(({ id }) => [
        request('/fred/series', id),
        request('/fred/series/observations', id, { sort_order: 'desc', limit: id === 'CPIAUCSL' ? '24' : '14' }),
      ])
      draining = true
      void Promise.allSettled(requests.flat()).then(() => { draining = false })
      const data = await Promise.race([timeout, Promise.all(requests.map(pair => Promise.all(pair)))])
      const collectedAt = now().toISOString()
      return {
        source: { label: 'FRED', simulated: false },
        indicators: series.flatMap((definition, index) => normalize(definition, ...data[index], collectedAt)),
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
    if (!apiKey) throw new FredError(503)
    if (pending) return pending
    const time = clock()
    while (started.length && time - started[0] >= 60_000) started.shift()
    if (draining || started.length >= maxBatchesPerMinute) throw new FredError(503)
    started.push(time)
    pending = load(apiKey).finally(() => { pending = undefined })
    return pending
  }
}
