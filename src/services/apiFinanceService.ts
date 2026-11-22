import type { DailyOhlcvBar, MarketDailyHistory } from '../types/marketDataProvider'
import type { EconomyIndicators, FredIndicator, KrxAnalysis, KrxMarket, KrxMarketRow, KrxOverview, KrxStock, KrxStocks, MarketIndex, Period, SeriesPoint } from '../types/finance'
import type { FinanceService } from './financeService'
import { fetchMemberApi } from './memberTransport'
import { recordProviderStatus } from './providerStatus'

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

function isFredIndicator(value: unknown): value is FredIndicator {
  if (!isRecord(value) || !isText(value.seriesId) || !/^[A-Z0-9]+$/.test(value.seriesId)
    || !isText(value.id) || !isText(value.name) || (value.unit !== '%' && value.unit !== 'index')
    || value.releaseDate !== null || !isDate(value.collectedAt) || !isRecord(value.source)
    || value.source.name !== 'FRED' || !isText(value.source.agency)
    || value.source.url !== `https://fred.stlouisfed.org/series/${value.seriesId}`
    || (value.frequency !== undefined && !['daily', 'daily-7-day', 'monthly'].includes(String(value.frequency)))) return false
  if (value.comparisonPeriod != null && !isDate(value.comparisonPeriod)) return false
  if (value.previousObservationDate != null && !isDate(value.previousObservationDate)) return false
  if (value.change != null && (!isNumber(value.change) || !isDate(value.previousObservationDate))) return false
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

function parseRows<T>(value: unknown, valid: (row: unknown) => row is T, field: string): T[] {
  if (!Array.isArray(value)) throw new Error(`Invalid API field: ${field}`)
  const rows = value.filter(valid)
  if (value.length && !rows.length) throw new Error(`No valid API records: ${field}`)
  return rows
}

function isMarketIndex(value: unknown): value is MarketIndex {
  if (!isRecord(value) || !isText(value.id) || !isText(value.symbol) || !isText(value.name)
    || (value.market !== 'KR' && value.market !== 'US')) return false
  if (value.status === 'unavailable') {
    return ['provider-not-configured', 'no-observation', 'provider-error', 'not-published', 'rate-limited'].includes(String(value.reason))
      && value.price === null && value.change === null && value.changePercent === null
      && value.source === null && value.observedAt === null && value.collectedAt === null && value.tradingDate === null
  }
  return (value.status === 'available' || value.status === 'stale') && isNumber(value.price) && value.price > 0
    && isNullableNumber(value.change) && isNullableNumber(value.changePercent) && isDate(value.observedAt)
    && isDate(value.collectedAt) && isDate(value.tradingDate) && isText(value.source)
}

const isNullableNumber = (value: unknown) => value === null || isNumber(value)
const isKrxMarket = (value: unknown) => value === 'KOSPI' || value === 'KOSDAQ'
const isKrxReason = (value: unknown) => value === null ||
  ['provider-not-configured', 'provider-error', 'not-published', 'weekend', 'before-collection'].includes(String(value))
const isOptionalDate = (value: unknown) => value === null || isDate(value)
const isKrxQuote = (value: unknown) => value === null || (isRecord(value) && isNumber(value.price) && value.price > 0
  && isNullableNumber(value.volume) && isNullableNumber(value.change)
  && isNullableNumber(value.changePercent) && isDate(value.tradingDate))

function isKrxStock(value: unknown): value is KrxStock {
  return isRecord(value) && isText(value.symbol) && /^[0-9A-Z]{6}$/.test(value.symbol) && isText(value.name)
    && typeof value.englishName === 'string' && typeof value.shareClass === 'string' && isDate(value.listedOn)
    && isKrxMarket(value.market) && isKrxQuote(value.quote)
}

export async function getKrxStocks(market: KrxMarket, filters: { q?: string; symbol?: string }, signal: AbortSignal): Promise<KrxStocks> {
  const query = new URLSearchParams({ market, ...filters })
  const value = await getJson('/api/v1/market/kr/stocks?' + query, false, signal)
  const validStatus = (status: unknown) => isRecord(status) && ['available', 'stale', 'unavailable'].includes(String(status.status))
    && typeof status.source === 'string' && (status.collectedAt === null || isDate(status.collectedAt))
    && isKrxReason(status.reason)
  if (!isRecord(value) || value.market !== market || !Array.isArray(value.items)
    || !value.items.every(item => isKrxStock(item) && item.market === market)
    || !validStatus(value.listings) || !validStatus(value.trades)
    || (value.listingDate !== null && !isDate(value.listingDate))) throw new Error('Invalid KRX stock response')
  return value as unknown as KrxStocks
}

export async function getKrxAnalysis(symbol: string, signal: AbortSignal): Promise<KrxAnalysis> {
  const value = await getJson('/api/v1/market/kr/stocks/' + encodeURIComponent(symbol) + '/history', false, signal)
  if (!isRecord(value) || value.symbol !== symbol || !isText(value.name) || !isKrxMarket(value.market)
    || value.source !== 'KRX OPEN API' || !isKrxQuote(value.quote) || !isKrxReason(value.reason)
    || !isOptionalDate(value.latestDate) || !isOptionalDate(value.collectedAt) || !isOptionalDate(value.stoppedAt)
    || !(value.stoppedReason === null || value.stoppedReason === 'missing-observation' || value.stoppedReason === 'not-collected')
    || !isRecord(value.history) || value.history.currency !== 'KRW' || value.history.timeZone !== 'Asia/Seoul'
    || value.history.adjustment !== 'unadjusted' || !['complete', 'missing-observations'].includes(String(value.history.completeness))
    || !Array.isArray(value.history.bars) || value.history.bars.length > 390
    || !value.history.bars.every(bar => isRecord(bar) && isDate(bar.tradingDate)
      && [bar.open, bar.high, bar.low, bar.close, bar.volume].every(isNumber))) throw new Error('Invalid KRX history')
  return value as unknown as KrxAnalysis
}

function isKrxMarketRow(value: unknown): value is KrxMarketRow {
  return isRecord(value) && isText(value.name) && isText(value.symbol) && /^[0-9A-Z]{6}$/.test(value.symbol)
    && isText(value.shortName) && typeof value.mapped === 'boolean'
    && isKrxMarket(value.market) && isNumber(value.price) && value.price > 0 && isNumber(value.volume) && value.volume > 0
    && isNullableNumber(value.changePercent) && isNullableNumber(value.marketCap)
}

export async function getKrxOverview(signal: AbortSignal): Promise<KrxOverview> {
  const data = await getJson('/api/v1/market/kr/overview', false, signal)
  const rows = (value: unknown, limit: number) => Array.isArray(value) && value.length <= limit && value.every(isKrxMarketRow)
  if (!isRecord(data) || data.source !== 'KRX OPEN API' || !isOptionalDate(data.tradingDate) || !isOptionalDate(data.collectedAt)
    || !(isKrxReason(data.reason) || data.reason === 'same-date-data-unavailable')
    || !(data.leaders === null || (isRecord(data.leaders) &&
      [data.leaders.advances, data.leaders.declines, data.leaders.volume].every(value => rows(value, 5))))
    || !rows(data.tiles, 60) || !isRecord(data.marketTiles)
    || !rows(data.marketTiles.KOSPI, 60) || !rows(data.marketTiles.KOSDAQ, 60)) throw new Error('Invalid KRX overview')
  return data as unknown as KrxOverview
}

export async function getMarketIndices(signal: AbortSignal): Promise<MarketIndex[]> {
  const value = await getJson('/api/v1/market/snapshot', false, signal)
  if (!isRecord(value) || !isRecord(value.source) || value.source.simulated !== false
    || !Array.isArray(value.quotes) || !value.quotes.every(isMarketIndex)
    || new Set(value.quotes.map(quote => quote.id)).size !== value.quotes.length) {
    throw new Error('Invalid market snapshot')
  }
  return value.quotes
}

export class FinanceApiError extends Error {
  constructor(readonly status: number, readonly code?: string) {
    super(`Finance API request failed: ${status}`)
  }
}

export function marketRequestMessage(error: unknown, fallback: string): string {
  if (!(error instanceof FinanceApiError)) return fallback
  if (error.status === 401) return '로그인이 필요합니다. 세션이 만료됐다면 다시 로그인해 주세요.'
  if (error.status === 403) return '시장 데이터 조회에는 승인된 회원 권한이 필요합니다.'
  if (error.code === 'KRX_LOCAL_PROVIDER_DISABLED' || error.code === 'KRX_NOT_CONFIGURED') return 'KRX 공급자 미연결'
  if (error.status === 429) return '요청 한도에 도달했습니다. 잠시 후 다시 시도해 주세요.'
  if (error.status === 503) return '시장 데이터 공급자를 일시적으로 이용할 수 없습니다.'
  return fallback
}

export async function getJson(path: string, allowMissingIndex = false, signal?: AbortSignal, timeoutMs = 15_000, method: 'GET' | 'POST' = 'GET'): Promise<unknown> {
  const response = await fetchMemberApi(path, {
    method,
    signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]),
  }).catch(error => {
    if (!signal?.aborted && !(error instanceof DOMException && error.name === 'AbortError')) recordProviderStatus(path, 'error')
    throw error
  })
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null)
    if (allowMissingIndex && response.status === 404 && isRecord(body) && body.error === 'Index not found') return []
    const code = isRecord(body) && typeof body.code === 'string' ? body.code : undefined
    recordProviderStatus(path, 'error')
    throw new FinanceApiError(response.status, code)
  }
  const body: unknown = await response.json()
  if (isRecord(body)) {
    if (Array.isArray(body.indicators)) {
      const published = body.indicators.filter(item => isRecord(item) && item.status === 'published').length
      recordProviderStatus(path, !published ? 'unavailable' : published === body.indicators.length ? 'published' : 'partial')
    } else if (Array.isArray(body.rates)) {
      const rates = body.rates.filter(item => isRecord(item) && isNumber(item.rate))
      const today = rates.some(item => item.status === 'published_today') ||
        (isRecord(body.reference) && body.reference.status === 'published_today')
      recordProviderStatus(path, !rates.length ? 'unavailable' : today ? 'published' : 'previous')
    } else if (Array.isArray(body.companies) || isRecord(body.company)) {
      recordProviderStatus(path, body.filingsError || body.financialsError ? 'partial' : 'published')
    }
  }
  return body
}

export async function getEconomyIndicators(signal: AbortSignal): Promise<EconomyIndicators | null> {
  const response = await fetchMemberApi('/api/v1/economy/indicators', {
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    cache: 'no-store',
  })
  const path = '/api/v1/economy/indicators'
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null)
    const code = isRecord(body) && typeof body.code === 'string' ? body.code : undefined
    if (response.status === 503 && code === 'FRED_DISABLED') {
      recordProviderStatus(path, 'unavailable')
      return null
    }
    recordProviderStatus(path, 'error')
    throw new FinanceApiError(response.status, code)
  }
  const value: unknown = await response.json()
  if (!isRecord(value) || !isRecord(value.source) || value.source.label !== 'FRED'
    || value.source.simulated !== false || !Array.isArray(value.indicators)
    || value.indicators.length < 1 || !value.indicators.every(isFredIndicator)
    || new Set(value.indicators.map(indicator => indicator.id)).size !== value.indicators.length) {
    recordProviderStatus(path, 'error')
    throw new Error('Invalid economy API response')
  }
  const published = value.indicators.filter(indicator => indicator.value !== null).length
  recordProviderStatus(path, !published ? 'unavailable' : published === value.indicators.length ? 'published' : 'partial')
  return { source: { label: 'FRED', simulated: false }, indicators: value.indicators }
}

export const apiFinanceService: Pick<FinanceService, 'getPriceHistory' | 'getKeywordTrend'> = {
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

const usReasons = ['provider-not-configured', 'not-published', 'collecting', 'provider-error', 'rate-limited', 'unsupported'] as const
type UsReason = typeof usReasons[number]
type UsAnalysis = { status: 'unavailable'; reason: UsReason } | {
  status: 'available' | 'stale'; reason: UsReason | null; source: string; collectedAt: string;
  analysisStatus: 'available' | 'insufficient-history';
  quote: DailyOhlcvBar & { change: number | null; changePercent: number | null };
  history: MarketDailyHistory;
}

function isUsBar(value: unknown): value is DailyOhlcvBar {
  return isRecord(value) && isDate(value.tradingDate)
    && [value.open, value.high, value.low, value.close, value.volume].every(isNumber)
}

export async function getUsAnalysis(symbol: string, signal: AbortSignal, request = false, indexId?: string): Promise<UsAnalysis> {
  const path = indexId ? '/api/v1/market/us/indices/' + encodeURIComponent(indexId) + '/history'
    : '/api/v1/market/us/stocks/' + encodeURIComponent(symbol) + (request ? '/requests' : '/history')
  const value = await getJson(path, false, signal, 15_000, request ? 'POST' : 'GET')
  if (!isRecord(value)) throw new Error('Invalid US market response')
  const reason = usReasons.find(reason => reason === value.reason)
  if (value.status === 'unavailable' && reason) return { status: 'unavailable', reason }
  const { status, source, collectedAt, quote, history, analysisStatus } = value
  if ((status !== 'available' && status !== 'stale') || !isText(source) || !isDate(collectedAt)
    || (analysisStatus !== 'available' && analysisStatus !== 'insufficient-history')
    || !isRecord(quote) || !isNullableNumber(quote.change) || !isNullableNumber(quote.changePercent) || !isUsBar(quote)
    || !isRecord(history) || history.currency !== 'USD' || history.timeZone !== 'America/New_York'
    || history.adjustment !== (indexId ? 'unadjusted' : 'total-return-adjusted') || history.completeness !== 'complete'
    || !Array.isArray(history.bars) || history.bars.length > 550 || !history.bars.every(isUsBar)) throw new Error('Invalid US stock history')
  return { status, reason: reason ?? null, source, collectedAt, analysisStatus,
    quote: { ...quote, change: quote.change as number | null, changePercent: quote.changePercent as number | null },
    history: { currency: history.currency, timeZone: history.timeZone, adjustment: indexId ? 'unadjusted' : 'total-return-adjusted',
      completeness: history.completeness, bars: history.bars } }
}
