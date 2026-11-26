import { invalidResponse, isDay, providerClient, ProviderError, withHealthMetadata } from './public-provider.mjs'

const source = { name: '한국은행 ECOS', url: 'https://ecos.bok.or.kr/' }
const bok = { name: '한국은행', url: 'https://www.bok.or.kr/portal/singl/baseRate/list.do?menuNo=200656' }
const kosis = { name: '국가데이터처 KOSIS', url: 'https://kosis.kr/visual/economyBoard/economyDash.do' }
const cacheTtlMs = 5 * 60_000
const partialCacheTtlMs = 30_000
const series = [
  { id: 'base-rate', name: '한국은행 기준금리', table: '722Y001', items: ['0101000'], cycle: 'D', unit: '연%', agency: bok },
  { id: 'cpi', name: '소비자물가지수', table: '901Y009', items: ['0'], cycle: 'M', unit: '2020=100', agency: kosis },
  { id: 'unemployment', name: '실업률 (원계열)', table: '901Y027', items: ['I61BC', 'I28A'], cycle: 'M', unit: '%', agency: kosis },
]

function ranges(now) {
  // ECOS reports Korean calendar days and months.
  now += 9 * 60 * 60_000
  const day = time => new Date(time).toISOString().slice(0, 10).replaceAll('-', '')
  const date = new Date(now)
  const month = time => day(time).slice(0, 6)
  const monthsAgo = offset => month(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - offset, 1))
  return {
    D: [day(now - 89 * 86_400_000), day(now), 90, day(now - 13 * 86_400_000)],
    M: [monthsAgo(23), month(now), 24, monthsAgo(3)],
  }
}

function observationFrom(document, series, from, to, count, currentFrom = from) {
  if (document?.RESULT?.CODE === 'INFO-200') return null
  if (document?.RESULT?.CODE) throw new ProviderError(502, 'ECOS_PROVIDER_ERROR')
  const rows = document?.StatisticSearch?.row
  if (!Array.isArray(rows) || !rows.length || rows.length > count) throw invalidResponse()
  const observations = new Map()
  let latest
  for (const row of rows) {
    if (row?.STAT_CODE !== series.table || row.ITEM_CODE1 !== series.items[0] || (row.ITEM_CODE2 || null) !== (series.items[1] ?? null)
      || row.UNIT_NAME !== series.unit || typeof row.TIME !== 'string' || row.TIME < from || row.TIME > to
      || typeof row.DATA_VALUE !== 'string' || !/^-?\d+(\.\d+)?$/.test(row.DATA_VALUE)) throw invalidResponse()
    const date = row.TIME.replace(/^(\d{4})(\d\d)(\d\d)?$/, (_, year, month, day) => `${year}-${month}-${day ?? '01'}`)
    const daily = series.cycle === 'D'
    const value = Number(row.DATA_VALUE)
    if (row.TIME.length !== from.length || !isDay(date) || observations.has(date) || !Number.isFinite(value)) throw invalidResponse()
    observations.set(date, value)
    if (row.TIME >= currentFrom && (!latest || date > latest.date)) {
      latest = { date, value, observationDate: daily ? date : null, observationPeriod: daily ? null : date.slice(0, 7) }
    }
  }
  if (!latest) return null
  const { date, ...observation } = latest
  observation.history = [...observations].sort(([left], [right]) => left.localeCompare(right))
    .map(([period, value]) => ({ period: series.cycle === 'D' ? period : period.slice(0, 7), value }))
  if (series.id === 'cpi' && observation.value > 0) {
    const priorDate = String(Number(date.slice(0, 4)) - 1) + date.slice(4)
    const priorValue = observations.get(priorDate)
    const change = (observation.value / priorValue - 1) * 100
    if (priorValue > 0 && Number.isFinite(change)) {
      observation.yearOverYear = { value: change, comparisonPeriod: priorDate.slice(0, 7) }
    }
  }
  return observation
}

export function createEcosProvider({ key = process.env.ECOS_API_KEY, fetchImpl = fetch, clock = Date.now } = {}) {
  const get = providerClient(fetchImpl, 500, { queue: true, maxBytes: 128 * 1024, timeoutMs: 3500 })
  let cached
  let pending

  async function load() {
    if (!key?.trim()) throw new ProviderError(503, 'ECOS_CONFIGURATION_MISSING')
    const range = ranges(clock())
    const indicators = []
    let failures = 0
    let lastError
    for (const entry of series) {
      const { id, name, table, items, cycle, unit, agency } = entry
      const [from, to, count, currentFrom] = range[cycle]
      const metadata = { id, name, unit, agency, series: { table, items, cycle } }
      if (lastError?.code === 'ECOS_PROVIDER_ERROR' || lastError?.statusCode === 503) {
        indicators.push({ ...metadata, status: 'unavailable', code: lastError.code })
        continue
      }
      try {
        const url = `https://ecos.bok.or.kr/api/StatisticSearch/${encodeURIComponent(key.trim())}/json/kr/1/${count}/${table}/${cycle}/${from}/${to}/${items.join('/')}`
        const observation = observationFrom(await get(url), entry, from, to, count, currentFrom)
        indicators.push(observation ? {
          ...metadata, ...observation, status: 'published', releaseDate: null, collectedAt: new Date(clock()).toISOString(),
        } : { ...metadata, status: 'unavailable' })
      } catch (error) {
        if (!(error instanceof ProviderError)) throw error
        lastError = error
        failures++
        indicators.push({ ...metadata, status: 'unavailable', code: error.code })
      }
    }
    if (failures && indicators.every(row => row.status === 'unavailable')) throw lastError
    return { source, indicators }
  }

  return async () => {
    if (cached && clock() < cached.expiresAt) return withHealthMetadata({ ...cached.data }, { usedCache: true, attempted: false })
    const shared = Boolean(pending)
    pending ??= load().then(data => {
      const complete = data.indicators.every(row => row.status === 'published')
      cached = { data, expiresAt: clock() + (complete ? cacheTtlMs : partialCacheTtlMs) }
      return data
    }).finally(() => { pending = undefined })
    return withHealthMetadata({ ...await pending }, { usedCache: false, attempted: !shared })
  }
}
