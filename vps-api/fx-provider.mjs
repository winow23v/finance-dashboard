import { createMarketCache } from './market-cache.mjs'
import { invalidResponse, isDay, providerClient } from './public-provider.mjs'

export const pairs = ['USD/KRW', 'EUR/KRW', 'USD/JPY']
const ecbQuotes = ['USD', 'KRW', 'JPY', 'CNY', 'GBP', 'CHF', 'AUD', 'CAD']
export const fxCurrencies = ['EUR', ...ecbQuotes]
export const fxPeriods = ['1W', '1M', '3M', '1Y']

const source = {
  name: 'Frankfurter v2',
  url: 'https://frankfurter.dev/',
  agency: 'European Central Bank (ECB)',
  agencyUrl: 'https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html',
}

function startDate(end, period) {
  const start = new Date(end)
  if (period === '1W') start.setUTCDate(start.getUTCDate() - 6)
  else {
    const day = start.getUTCDate()
    start.setUTCDate(1)
    start.setUTCMonth(start.getUTCMonth() - { '1M': 1, '3M': 3, '1Y': 12 }[period])
    const lastDay = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)).getUTCDate()
    start.setUTCDate(Math.min(day, lastDay))
  }
  return start.toISOString().slice(0, 10)
}

export function createFxProvider({ fetchImpl = fetch, clock = Date.now } = {}) {
  const get = providerClient(fetchImpl, 500, { maxBytes: 384 * 1024 })
  const cache = createMarketCache({ maxEntries: 2, maxPending: 2, timeoutMs: 7000, wallClock: clock })
  async function load() {
    const today = new Date(clock()).toISOString().slice(0, 10)
    const result = await cache.get(today, { ttlMs: 15 * 60_000, staleAfterMs: 0 }, async () => {
      const from = startDate(today, '1Y')
      const query = new URLSearchParams({ base: 'EUR', quotes: ecbQuotes.join(','), providers: 'ecb', from, to: today })
      const rows = await get(`https://api.frankfurter.dev/v2/rates?${query}`)
      if (!Array.isArray(rows) || !rows.length || rows.length > 367 * ecbQuotes.length) throw invalidResponse()
      const byDate = new Map()
      for (const row of rows) {
        if (!row || row.base !== 'EUR' || !ecbQuotes.includes(row.quote)
          || !isDay(row.date) || row.date < from || row.date > today
          || !Number.isFinite(row.rate) || row.rate <= 0) throw invalidResponse()
        const rates = byDate.get(row.date) ?? { EUR: 1 }
        if (Object.hasOwn(rates, row.quote)) throw invalidResponse()
        rates[row.quote] = row.rate
        byDate.set(row.date, rates)
      }
      return { asOf: today, data: { today, observations: [...byDate].sort(([a], [b]) => a.localeCompare(b)) } }
    })
    return { ...JSON.parse(result.body), collectedAt: result.storedAt }
  }

  function crossRate(rates, base, quote) {
    const rate = rates[quote] / rates[base]
    return Number.isFinite(rate) && rate > 0 ? rate : null
  }

  function series(observations, pair) {
    const [base, quote] = pair.split('/')
    return observations.flatMap(([observationDate, rates]) => {
      const rate = crossRate(rates, base, quote)
      return rate === null ? [] : [{ observationDate, rate }]
    })
  }

  function metadata(pair, point, { today, collectedAt }) {
    const [base, quote] = pair.split('/')
    return {
      base, quote, unit: `${quote} / 1 ${base}`, source, collectedAt,
      kind: 'reference', calculated: base !== 'EUR',
      status: !point ? 'unavailable' : point.observationDate === today ? 'published_today' : 'previous_publication',
    }
  }

  return {
    async latest() {
      const data = await load()
      const [observationDate, eurRates] = data.observations.at(-1)
      const rates = pairs.map(pair => {
        const point = series(data.observations, pair).at(-1)
        return { ...metadata(pair, point, data), observationDate: point?.observationDate ?? null, rate: point?.rate ?? null }
      })
      return { rates, reference: {
        observationDate, collectedAt: data.collectedAt, kind: 'reference',
        status: observationDate === data.today ? 'published_today' : 'previous_publication',
        rates: Object.fromEntries(fxCurrencies.map(base => [base, Object.fromEntries(
          fxCurrencies.filter(quote => quote !== base).map(quote => [quote, crossRate(eurRates, base, quote)]),
        )])),
      } }
    },
    async history(pair, period) {
      const data = await load()
      const from = startDate(data.today, period)
      const points = series(data.observations.filter(([date]) => date >= from), pair)
      return { ...metadata(pair, points.at(-1), data), period, from, to: data.today, points }
    },
  }
}
