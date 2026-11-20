import type { EconomyIndicators, FinanceSnapshot, FredIndicator, Indicator, Period, Quote, SeriesPoint } from '../types/finance'
import type { FinanceService } from './financeService'

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

export function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function isQuote(value: unknown): value is Quote {
  if (!isRecord(value) || !isText(value.id) || !isText(value.name) || !isText(value.symbol)
    || (value.currency !== 'KRW' && value.currency !== 'USD') || !isNumber(value.price)
    || !isNumber(value.change) || !isNumber(value.percent) || !isDate(value.asOf)
    || typeof value.delayed !== 'boolean') return false

  if (value.kind === 'fx') return value.market === 'FX'
  if (value.market !== 'KR' && value.market !== 'US') return false
  return value.kind === 'index' || ((value.kind === 'stock' || value.kind === 'etf') && isText(value.exchange))
}

function isIndicator(value: unknown): value is Indicator {
  return isRecord(value) && isText(value.id) && isText(value.name) && isNumber(value.value)
    && value.unit === '%' && isDate(value.observationDate) && isDate(value.releaseDate) && isDate(value.collectedAt)
}

function isFredIndicator(value: unknown): value is FredIndicator {
  if (!isRecord(value) || !isText(value.seriesId) || !/^[A-Z0-9]+$/.test(value.seriesId)
    || !isText(value.id) || !isText(value.name) || (value.unit !== '%' && value.unit !== 'index')
    || value.releaseDate !== null || !isDate(value.collectedAt) || !isRecord(value.source)
    || value.source.name !== 'FRED' || !isText(value.source.agency)
    || value.source.url !== `https://fred.stlouisfed.org/series/${value.seriesId}`) return false
  if (value.comparisonPeriod != null && !isDate(value.comparisonPeriod)) return false
  if (value.missingReason != null && value.missingReason !== 'CURRENT_MISSING'
    && value.missingReason !== 'COMPARISON_MISSING') return false

  const validDate = isDate(value.observationDate)
  return value.value === null
    ? (value.observationDate === null || validDate) && value.stale === null
    : validDate && isNumber(value.value) && typeof value.stale === 'boolean'
}

function isPoint(value: unknown): value is SeriesPoint {
  return isRecord(value) && isDate(value.at) && isNumber(value.value)
}

function isStatus(value: unknown): value is 'open' | 'closed' {
  return value === 'open' || value === 'closed'
}

function parseRows<T>(value: unknown, valid: (row: unknown) => row is T, field: string): T[] {
  if (!Array.isArray(value)) throw new Error(`Invalid API field: ${field}`)
  const rows = value.filter(valid)
  if (value.length && !rows.length) throw new Error(`No valid API records: ${field}`)
  return rows
}

function parseSnapshot(value: unknown): FinanceSnapshot {
  if (!isRecord(value) || !isRecord(value.source) || !isText(value.source.label)
    || typeof value.source.simulated !== 'boolean' || !isDate(value.updatedAt)
    || !isRecord(value.marketStatus) || !isStatus(value.marketStatus.KR) || !isStatus(value.marketStatus.US)) {
    throw new Error('Invalid API snapshot metadata')
  }
  const quotes = parseRows(value.quotes, isQuote, 'quotes')
  const indicators = parseRows(value.indicators, isIndicator, 'indicators')
  return {
    source: { label: value.source.label, simulated: value.source.simulated },
    updatedAt: value.updatedAt,
    quotes: [...new Map(quotes.map(quote => [quote.id, quote])).values()],
    indicators: [...new Map(indicators.map(indicator => [indicator.id, indicator])).values()],
    marketStatus: { KR: value.marketStatus.KR, US: value.marketStatus.US },
    trendTopics: [...new Set(parseRows(value.trendTopics, isText, 'trendTopics'))],
  }
}

function requestUrl(path: string): string {
  const configured = import.meta.env.VITE_API_BASE_URL?.trim()
  if (import.meta.env.DEV && !configured) return path
  if (!configured) throw new Error('VITE_API_BASE_URL is required in production API mode')

  const base = new URL(configured)
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) {
    throw new Error('VITE_API_BASE_URL must be an HTTPS base URL')
  }
  return base.href.replace(/\/+$/, '') + path
}

export class FinanceApiError extends Error {
  constructor(status: number, readonly code?: string) {
    super(`Finance API request failed: ${status}`)
  }
}

export async function getJson(path: string, allowMissingIndex = false, signal?: AbortSignal, timeoutMs = 15_000): Promise<unknown> {
  const response = await fetch(requestUrl(path), {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]),
  })
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null)
    if (allowMissingIndex && response.status === 404 && isRecord(body) && body.error === 'Index not found') return []
    throw new FinanceApiError(response.status, isRecord(body) && typeof body.code === 'string' ? body.code : undefined)
  }
  return response.json()
}

export async function getEconomyIndicators(signal: AbortSignal): Promise<EconomyIndicators | null> {
  const response = await fetch(requestUrl('/api/v1/economy/indicators'), {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    cache: 'no-store',
  })
  if (response.status === 503) {
    const body: unknown = await response.json()
    if (isRecord(body) && body.code === 'FRED_DISABLED') return null
  }
  if (!response.ok) throw new Error(`Economy API request failed: ${response.status}`)
  const value: unknown = await response.json()
  if (!isRecord(value) || !isRecord(value.source) || value.source.label !== 'FRED'
    || value.source.simulated !== false || !Array.isArray(value.indicators)
    || value.indicators.length !== 5 || !value.indicators.every(isFredIndicator)
    || new Set(value.indicators.map(indicator => indicator.id)).size !== 5) {
    throw new Error('Invalid economy API response')
  }
  return { source: { label: 'FRED', simulated: false }, indicators: value.indicators }
}

export const apiFinanceService: FinanceService = {
  async getSnapshot() {
    return parseSnapshot(await getJson('/api/v1/market/snapshot'))
  },
  async getPriceHistory(symbolId: string, period: Period) {
    const query = new URLSearchParams({ symbolId, period })
    const value = await getJson(`/api/v1/market/history?${query}`, true)
    const points = parseRows(value, isPoint, 'history')
    const byTime = new Map(points.map(point => [Date.parse(point.at), point]))
    return [...byTime].sort(([left], [right]) => left - right).map(([, point]) => point)
  },
  async getKeywordTrend() {
    return []
  },
}
