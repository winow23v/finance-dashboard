import { setTimeout as delay } from 'node:timers/promises'
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

const freshnessMs = 15 * 60_000
const retryDelayMs = 60_000

export function createFxProvider({ fetchImpl = fetch, clock = Date.now, timeoutMs = 6000 } = {}) {
  const get = providerClient(fetchImpl, 500, { queue: true, maxBytes: 384 * 1024, timeoutMs, detailedErrors: true })
  let lastGood
  let failure
  let pending

  async function refresh(today) {
    const from = startDate(today, '1Y')
    const earliestAnchor = new Date(Date.parse(from) - 7 * 86_400_000).toISOString().slice(0, 10)
    const query = new URLSearchParams({ base: 'EUR', quotes: ecbQuotes.join(','), providers: 'ecb', from, to: today })
    const url = `https://api.frankfurter.dev/v2/rates?${query}`
    const rows = await get(url).catch(async error => {
      if (error.code !== 'PROVIDER_TIMEOUT' && !error.transientNetwork) throw error
      // Keep the two six-second attempts inside the browser's 15-second deadline.
      await delay(500)
      return get(url)
    })
    if (!Array.isArray(rows) || !rows.length || rows.length > 367 * ecbQuotes.length) throw invalidResponse()
    const byDate = new Map()
    let anchor
    for (const row of rows) {
      if (!row || row.base !== 'EUR' || !ecbQuotes.includes(row.quote)
        || !isDay(row.date) || row.date < earliestAnchor || row.date > today
        || !Number.isFinite(row.rate) || row.rate <= 0) throw invalidResponse()
      if (row.date < from) {
        // Frankfurter can include the preceding publication for a non-trading start date.
        if (anchor && anchor !== row.date) throw invalidResponse()
        anchor = row.date
      }
      const rates = byDate.get(row.date) ?? { EUR: 1 }
      if (Object.hasOwn(rates, row.quote)) throw invalidResponse()
      rates[row.quote] = row.rate
      byDate.set(row.date, rates)
    }
    if (anchor) byDate.delete(anchor)
    const observations = [...byDate].sort(([a], [b]) => a.localeCompare(b))
    const reference = observations.findLast(([, rates]) => ['USD', 'KRW', 'JPY'].every(code => Object.hasOwn(rates, code)))
    if (!reference || (lastGood && reference[0] < lastGood.reference[0])) throw invalidResponse()

    const time = clock()
    lastGood = { observations, reference, requestedDay: today, collectedAt: new Date(time).toISOString(), expires: time + freshnessMs }
    failure = undefined
  }

  async function load() {
    const now = clock()
    const today = new Date(now).toISOString().slice(0, 10)
    if (lastGood?.requestedDay !== today || now >= lastGood.expires) {
      if (!failure || now >= failure.retryAt) {
        pending ??= refresh(today).catch(error => {
          failure = { error, retryAt: clock() + retryDelayMs }
        }).finally(() => { pending = undefined })
        await pending
      }
      if (!lastGood) throw failure.error
    }
    return { ...lastGood, today, refreshError: failure?.error.code }
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

  function metadata(pair, point, { today, collectedAt, refreshError }) {
    const [base, quote] = pair.split('/')
    return {
      base, quote, unit: `${quote} / 1 ${base}`, source, collectedAt,
      kind: 'reference', calculated: base !== 'EUR',
      status: !point ? 'unavailable' : !refreshError && point.observationDate === today ? 'published_today' : 'previous_publication',
    }
  }

  return {
    async latest() {
      const data = await load()
      const [observationDate, eurRates] = data.reference
      const rates = pairs.map(pair => {
        const point = series(data.observations, pair).at(-1)
        return { ...metadata(pair, point, data), observationDate: point?.observationDate ?? null, rate: point?.rate ?? null }
      })
      return { rates, ...(data.refreshError && { refreshError: data.refreshError }), reference: {
        observationDate, collectedAt: data.collectedAt, kind: 'reference',
        status: !data.refreshError && observationDate === data.today ? 'published_today' : 'previous_publication',
        rates: Object.fromEntries(fxCurrencies.map(base => [base, Object.fromEntries(
          fxCurrencies.filter(quote => quote !== base).map(quote => [quote, crossRate(eurRates, base, quote)]),
        )])),
      } }
    },
    async history(pair, period) {
      const data = await load()
      const from = startDate(data.today, period)
      const points = series(data.observations.filter(([date]) => date >= from), pair)
      return { ...metadata(pair, points.at(-1), data), period, from, to: data.today, points, ...(data.refreshError && { refreshError: data.refreshError }) }
    },
  }
}
