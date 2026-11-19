import Fastify from 'fastify'

const app = Fastify({ logger: true })
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

app.get('/health', async () => ({ status: 'ok' }))

app.get('/api/v1/market/snapshot', async () => ({
  source: { label: 'DEMO', simulated: true },
  updatedAt: asOf,
  quotes,
  indicators: [],
  marketStatus: { KR: 'closed', US: 'closed' },
  trendTopics: [],
}))

app.get('/api/v1/market/history', {
  schema: {
    querystring: {
      type: 'object',
      required: ['symbolId'],
      properties: {
        symbolId: { type: 'string', minLength: 1 },
        period: { type: 'string', enum: Object.keys(periods), default: '1M' },
      },
    },
  },
}, async (request, reply) => {
  const { symbolId, period } = request.query
  const quote = quotes.find(item => item.id === symbolId && item.kind === 'index')
  if (!quote) return reply.code(404).send({ error: 'Index not found' })

  return Array.from({ length: 25 }, (_, index) => {
    const progress = index / 24
    const offset = (1 - progress) * periods[period] * 86_400_000
    const variation = (Math.sin(index * 1.7) * 0.004 - 0.024) * (1 - progress)
    return {
      at: new Date(Date.parse(quote.asOf) - offset).toISOString(),
      value: Math.round(quote.price * (1 + variation) * 100) / 100,
    }
  })
})

try {
  await app.listen({ host: '127.0.0.1', port: 3000 })
} catch (error) {
  app.log.error(error)
  process.exitCode = 1
}
