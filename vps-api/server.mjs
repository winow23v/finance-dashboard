import { pathToFileURL } from 'node:url'
import { STATUS_CODES } from 'node:http'
import Fastify, { LogController } from 'fastify'
import rateLimit from '@fastify/rate-limit'
import { createMarketCache, MarketError } from './market-cache.mjs'

const asOf = '2026-11-18T21:00:00Z'
const periods = { '1D': 0.27, '1W': 7, '1M': 30, '3M': 90, '1Y': 365 }

const quotes = [
  ['kospi', 'KOSPI', 'KRX:KOSPI', 'KR', 'index', 'KRW', 2658.41, 21.63, 0.82],
  ['kosdaq', 'KOSDAQ', 'KRX:KOSDAQ', 'KR', 'index', 'KRW', 784.22, -3.62, -0.46],
  ['spx', 'S&P 500', 'SPX', 'US', 'index', 'USD', 5870.62, 35.02, 0.60],
  ['nasdaq', 'NASDAQ', 'IXIC', 'US', 'index', 'USD', 18972.42, 214.04, 1.14],
  ['usdkrw', 'USD/KRW', 'USD/KRW', 'FX', 'fx', 'KRW', 1382.50, -4.50, -0.32],
].map(([id, name, symbol, market, kind, currency, price, change, percent]) => ({
  id, name, symbol, market, kind, currency, price, change, percent,
  asOf, delayed: false,
}))

const policies = {
  snapshot: { ttlMs: 30_000, staleAfterMs: 15 * 60_000 },
  history: { ttlMs: 5 * 60_000, staleAfterMs: 24 * 60 * 60_000 },
}

const demoProvider = {
  snapshot: () => ({
    asOf,
    data: {
      source: { label: 'DEMO', simulated: true },
      updatedAt: asOf,
      quotes,
      indicators: [],
      marketStatus: { KR: 'closed', US: 'closed' },
      trendTopics: [],
    },
  }),
  history: (quote, period) => ({
    asOf: quote.asOf,
    data: Array.from({ length: 25 }, (_, index) => {
      const progress = index / 24
      const offset = (1 - progress) * periods[period] * 86_400_000
      const variation = (Math.sin(index * 1.7) * 0.004 - 0.024) * (1 - progress)
      return {
        at: new Date(Date.parse(quote.asOf) - offset).toISOString(),
        value: Math.round(quote.price * (1 + variation) * 100) / 100,
      }
    }),
  }),
}

const noQuery = { type: 'object', additionalProperties: false }

export async function buildApp({
  provider = demoProvider,
  cache = createMarketCache(),
  logger = true,
} = {}) {
  const app = Fastify({
    logger,
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 8192,
    ajv: { customOptions: { removeAdditional: false } },
    trustProxy: (address, hop) => hop === 0 && address === '127.0.0.1',
  })

  app.setErrorHandler((error, request, reply) => {
    const status = error.statusCode >= 400 && error.statusCode <= 599 ? error.statusCode : 500
    if (status >= 500) request.log.warn({ statusCode: status }, 'Request failed')
    const label = STATUS_CODES[status] ?? 'Request Failed'
    const message = error instanceof MarketError ? error.message : label
    reply.code(status).send({ statusCode: status, error: label, message })
  })

  await app.register(rateLimit, {
    max: request => request.routeOptions.config.healthCheck ? 120 : 60,
    keyGenerator: request => request.routeOptions.config.healthCheck ? `health:${request.ip}` : request.ip,
    timeWindow: 60_000,
    cache: 5000,
  })

  app.setNotFoundHandler(async (_request, reply) => reply.code(404).send({ error: 'Not Found' }))

  async function sendMarket(reply, key, policy, load) {
    const result = await cache.get(key, policy, load)
    return reply
      .header('x-market-as-of', result.asOf)
      .header('x-cache-stored-at', result.storedAt)
      .header('x-market-stale', String(result.stale))
      .type('application/json')
      .send(result.body)
  }

  app.get('/health', {
    config: { healthCheck: true },
    schema: { querystring: noQuery },
  }, async () => ({ status: 'ok' }))

  app.get('/api/v1/market/snapshot', {
    schema: { querystring: noQuery },
  }, async (_request, reply) => sendMarket(reply, 'snapshot', policies.snapshot,
    signal => provider.snapshot(signal)))

  app.get('/api/v1/market/history', {
    schema: {
      querystring: {
        type: 'object',
        additionalProperties: false,
        required: ['symbolId'],
        properties: {
          symbolId: { type: 'string', minLength: 1, maxLength: 32, pattern: '^[A-Za-z0-9_-]+$' },
          period: { type: 'string', enum: Object.keys(periods), default: '1M' },
        },
      },
    },
  }, async (request, reply) => {
    const { symbolId, period } = request.query
    const quote = quotes.find(item => item.id === symbolId && item.kind === 'index')
    if (!quote) return reply.code(404).send({ error: 'Index not found' })

    return sendMarket(reply, `history:${symbolId}:${period}`, policies.history,
      signal => provider.history(quote, period, signal))
  })

  return app
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const app = await buildApp()
    await app.listen({ host: '127.0.0.1', port: 3000 })
  } catch {
    console.error('Finance API startup failed')
    process.exitCode = 1
  }
}
