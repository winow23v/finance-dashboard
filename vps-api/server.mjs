import { createFinancialStorage } from './financial-storage-provider.mjs'
import { createFundamentalsProvider } from './fundamentals-provider.mjs'
import { registerOciMonitorWeb } from './oci-monitor-web-provider.mjs'
import { registerOciMonitorStatus } from './oci-monitor-status-provider.mjs'
import { createProviderHealth } from './health-provider.mjs'
import { pathToFileURL } from 'node:url'
import { STATUS_CODES } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import Fastify, { LogController } from 'fastify'
import rateLimit from '@fastify/rate-limit'
import { configureMemberFred, createFredProvider, FredError } from './fred-provider.mjs'
import { createMarketCache, MarketError } from './market-cache.mjs'

import { createFxProvider, fxCurrencies, fxPeriods } from './fx-provider.mjs'
import { createEcosProvider } from './ecos-provider.mjs'
import { createDartProvider, dartPeriods } from './dart-provider.mjs'
import { verifyDartFinancialCache } from './dart-financials-provider.mjs'
import { createMembership, memberStatuses, uuidPattern } from './membership-provider.mjs'
import { ProviderError } from './public-provider.mjs'
import { createIndexSnapshot, marketIndices } from './market-index-provider.mjs'
import { configureMemberUsMarket, usTickerSchema } from './us-market-provider.mjs'
import { configureMemberKrx, createKrxProvider } from './krx-provider.mjs'

const periods = ['1D', '1W', '1M', '3M', '1Y']
const policies = {
  snapshot: { ttlMs: 30_000, staleAfterMs: 24 * 60 * 60_000 },
  history: { ttlMs: 5 * 60_000, staleAfterMs: 24 * 60 * 60_000 },
}
const unavailableSnapshot = createIndexSnapshot()

function isLocalResearchRequest(request) {
  return request.raw.socket.remoteAddress === '127.0.0.1' &&
    /^127\.0\.0\.1(?::\d+)?$/.test(request.headers.host ?? '') &&
    !Object.keys(request.headers).some(name => name === 'forwarded' || name === 'x-real-ip' || name.startsWith('x-forwarded-'))
}

const noQuery = { type: 'object', additionalProperties: false }

const favoriteSchema = {
  type: 'object', additionalProperties: false, required: ['market', 'exchange', 'symbol'],
  properties: { market: { type: 'string' }, exchange: { type: 'string' }, symbol: { type: 'string' } },
  oneOf: [
    { properties: { market: { const: 'KR' }, exchange: { const: 'XKRX' },
      symbol: { type: 'string', pattern: '^[0-9A-Z]{6}$' } } },
    { properties: { market: { const: 'US' }, exchange: { enum: ['US', 'XNAS', 'XNYS', 'ARCX'] },
      symbol: usTickerSchema } },
  ],
}

// Node parser errors may include the raw HTTP packet, including credentials.
function handleClientError(error, socket) {
  if (error.code === 'ECONNRESET' || socket.destroyed) return
  const [status, message] = error.code === 'ERR_HTTP_REQUEST_TIMEOUT' ? [408, 'Client Timeout']
    : error.code === 'HPE_HEADER_OVERFLOW' ? [431, 'Exceeded maximum allowed HTTP header size']
      : [400, 'Client Error']
  const label = STATUS_CODES[status]
  const body = JSON.stringify({ error: label, message, statusCode: status })
  if (socket.writable) {
    socket.end(`HTTP/1.1 ${status} ${label}\r\nContent-Length: ${Buffer.byteLength(body)}\r\n` +
      `Content-Type: application/json\r\nConnection: close\r\n\r\n${body}`)
  } else {
    socket.destroy()
  }
}

export async function buildApp({
  provider,
  localIndexResearch,
  localKrx,
  memberKrx,
  memberUs,
  cache = createMarketCache(),
  logger = true,
  ociMonitorStatus,
  ociMonitorWeb,
  getEconomyIndicators,
  privateAccessToken,
  privateOnly = false,
  membership,
  memberFred,
  financialStorageEnabled = false,
  memberRateLimit = 60,
  fx = createFxProvider(),
  ecos = createEcosProvider(),
  dart = createDartProvider(),
  providerHealth = createProviderHealth({ configured: {
    krx: Boolean(memberKrx || localKrx), yfinance: Boolean(memberUs), 'kr-intraday': false,
  } }),
} = {}) {
  if (memberKrx && (!membership || privateOnly)) {
    throw new Error('Member KRX requires membership authentication')
  }
  if (memberUs && (!membership || privateOnly)) throw new Error('Member US market requires membership authentication')
  if (memberUs) {
    const provider = memberUs
    memberUs = Object.fromEntries(['index', 'indexAnalysis', 'history', 'stock', 'request'].flatMap(method =>
      typeof provider[method] === 'function'
        ? [[method, (...args) => providerHealth.observe('yfinance', () => provider[method](...args), args[0])]] : []))
  }
  const memberSnapshot = (memberKrx || memberUs) && createIndexSnapshot(undefined, memberKrx,
    memberUs ? 'Market indices' : 'KRX OPEN API', memberUs)
  const krxFor = request => localKrx && isLocalResearchRequest(request) ? localKrx : memberKrx
  if (getEconomyIndicators && !/^[a-f0-9]{64}$/.test(privateAccessToken ?? '')) {
    throw new Error('Private FRED access token is missing or invalid')
  }
  const privateAuthorization = getEconomyIndicators ? Buffer.from(`Bearer ${privateAccessToken}`) : null
  const app = Fastify({
    logger,
    clientErrorHandler: handleClientError,
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 8192,
    ajv: { customOptions: { removeAdditional: false } },
    trustProxy: (address, hop) => hop === 0 && address === '127.0.0.1',
  })

  app.setErrorHandler((error, request, reply) => {
    const status = error.statusCode >= 400 && error.statusCode <= 599 ? error.statusCode : 500
    if (status >= 500) request.log.warn({ statusCode: status }, 'Request failed')
    const label = STATUS_CODES[status] ?? 'Request Failed'
    const message = error instanceof MarketError || error instanceof FredError ? error.message : label
    reply.code(status).send({ statusCode: status, error: label, message,
      ...((error instanceof ProviderError || error instanceof FredError) && { code: error.code }),
    })
  })

  app.addHook('onRequest', async (_request, reply) => {
    reply.header('cache-control', 'no-store')
    reply.header('x-content-type-options', 'nosniff')
  })

  await app.register(rateLimit, {
    max: request => request.routeOptions.config.healthCheck ? 120 : 60,
    keyGenerator: request => request.routeOptions.config.healthCheck ? `health:${request.ip}` : request.ip,
    timeWindow: 60_000,
    cache: 5000,
  })

  if (privateOnly) app.addHook('onRequest', async (request, reply) => {
    if (!request.routeOptions.config?.healthCheck && !request.routeOptions.config?.localFred) {
      return reply.code(404).send({ error: 'Not Found' })
    }
  })

  if (!privateOnly && ociMonitorStatus) registerOciMonitorStatus(app, ociMonitorStatus)

  if (!privateOnly && ociMonitorWeb) app.register(registerOciMonitorWeb, { ...ociMonitorStatus, ...ociMonitorWeb })

  if (membership) {
    app.decorateRequest('memberUser', null)
    const limitMember = app.createRateLimit({
      max: memberRateLimit, keyGenerator: request => 'member:' + request.memberUser.id,
    })
    app.addHook('onRequest', async (request, reply) => {
      const access = request.routeOptions.config?.access
      if (request.routeOptions.config?.healthCheck || request.routeOptions.config?.ociMonitorStatus || access === 'preflight') return
      const authorization = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i.exec(request.headers.authorization ?? '')
      const user = authorization && await membership.verify(authorization[1])
      if (!user) return reply.header('www-authenticate', 'Bearer').code(401).send({ code: 'AUTH_REQUIRED' })

      request.memberUser = user
      const limit = await limitMember(request)
      if (limit.isExceeded) return reply.header('retry-after', Math.max(1, Math.ceil(limit.ttl / 1000)))
        .code(429).send({ code: 'MEMBER_RATE_LIMITED' })
      if (access === 'session') return
      const member = await membership.read(user.id)
      if (member?.status !== 'approved') return reply.code(403).send({ code: 'MEMBER_NOT_APPROVED' })
      if (access === 'admin' && !membership.isAdmin(user.id)) {
        return reply.code(403).send({ code: 'ADMIN_REQUIRED' })
      }
    })

    app.options('/api/v1/*', { config: { access: 'preflight' } }, async (_request, reply) => reply
      .header('access-control-allow-methods', 'GET, HEAD, POST, PATCH, DELETE, OPTIONS')
      .header('access-control-allow-headers', 'Authorization, Content-Type')
      .header('access-control-max-age', '600').code(204).send())
    app.get('/api/v1/watchlist', { schema: { querystring: noQuery } }, async request =>
      ({ items: await membership.watchlist(request.memberUser.id) }))
    app.post('/api/v1/watchlist', { schema: { querystring: noQuery, body: {
      type: 'object', additionalProperties: false, required: ['items'],
      properties: { items: { type: 'array', minItems: 1, maxItems: 100, items: favoriteSchema } },
    } } }, async (request, reply) => {
      const unique = new Map()
      for (const item of request.body.items) {
        const key = JSON.stringify([item.market, item.symbol])
        if (!unique.has(key)) unique.set(key, item)
      }
      await membership.addFavorites(request.memberUser.id, [...unique.values()])
      return reply.code(204).send()
    })
    app.delete('/api/v1/watchlist/:market/:exchange/:symbol', {
      schema: { querystring: noQuery, params: favoriteSchema },
    }, async (request, reply) => {
      await membership.deleteFavorite(request.memberUser.id, request.params)
      return reply.code(204).send()
    })
    app.get('/api/v1/session', {
      config: { access: 'session' }, schema: { querystring: noQuery },
    }, async request => {
      const user = request.memberUser
      const member = await membership.register(user)
      return { userId: user.id, email: user.email, status: member.status,
        admin: member.status === 'approved' && membership.isAdmin(user.id) }
    })
    const pageProperties = {
      page: { type: 'integer', minimum: 1, maximum: 100000, default: 1 },
      status: { enum: memberStatuses },
    }
    app.get('/api/v1/admin/providers', {
      config: { access: 'admin' }, schema: { querystring: noQuery },
    }, () => providerHealth.snapshot())
    app.get('/api/v1/admin/members', {
      config: { access: 'admin' },
      schema: { querystring: { type: 'object', additionalProperties: false,
        properties: pageProperties } },
    }, async request => membership.list(request.query.page, request.query))
    app.post('/api/v1/admin/members/search', {
      config: { access: 'admin' },
      schema: { querystring: noQuery, body: { type: 'object', additionalProperties: false, required: ['email'],
        properties: { ...pageProperties, email: { type: 'string', maxLength: 254, pattern: '^[^\\s@]+@[^\\s@]+$' } } } },
    }, async request => membership.list(request.body.page, request.body))
    app.patch('/api/v1/admin/members/:id', {
      config: { access: 'admin' },
      schema: {
        querystring: noQuery,
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: uuidPattern } } },
        body: { type: 'object', additionalProperties: false, required: ['status', 'expectedStatus'],
          properties: {
            status: { enum: memberStatuses },
            expectedStatus: { enum: memberStatuses },
          } },
      },
    }, async (request, reply) => {
      const id = request.params.id.toLowerCase()
      if (membership.isAdmin(id)) return reply.code(409).send({ code: 'ADMIN_STATUS_PROTECTED' })
      const { status, expectedStatus } = request.body
      if (status === 'pending' && expectedStatus !== 'approved') {
        return reply.code(409).send({ code: 'MEMBER_STATUS_CONFLICT' })
      }
      const member = await membership.update(id, status, expectedStatus, request.memberUser.id)
      if (!member) return reply.code(409).send({ code: 'MEMBER_STATUS_CONFLICT' })
      return member
    })
  }

  app.setNotFoundHandler(async (_request, reply) => reply.code(404).send({ error: 'Not Found' }))

  async function sendMarket(reply, key, policy, load) {
    const result = await cache.get(key, policy, load)
    if (result.asOf !== null) {
      reply.header('x-market-as-of', result.asOf).header('x-market-stale', String(result.stale))
    }
    return reply
      .header('x-cache-stored-at', result.storedAt)
      .type('application/json')
      .send(result.body)
  }

  app.get('/health', {
    config: { healthCheck: true },
    schema: { querystring: noQuery },
  }, async () => ({ status: 'ok' }))

  app.get('/api/v1/economy/indicators', {
    exposeHeadRoute: false,
    config: { localFred: true },
    schema: { querystring: noQuery },
  }, async (request, reply) => {
    if (membership && memberFred) return memberFred()
    if (membership || !getEconomyIndicators) {
      return reply.code(503).send({ code: 'FRED_DISABLED', error: 'FRED integration is disabled' })
    }
    const forwarded = Object.keys(request.headers).some(name =>
      name === 'forwarded' || name === 'x-real-ip' || name.startsWith('x-forwarded-'))
    const authorization = Buffer.from(request.headers.authorization ?? '')
    if (request.raw.socket.remoteAddress !== '127.0.0.1' || request.headers.host !== '127.0.0.1:3001' || forwarded ||
      authorization.length !== privateAuthorization.length || !timingSafeEqual(authorization, privateAuthorization)) {
      return reply.code(404).send({ error: 'Not Found' })
    }
    return getEconomyIndicators()
  })

  app.get('/api/v1/fx/latest', { schema: { querystring: noQuery } }, () => providerHealth.observe('fx', () => fx.latest()))

  app.get('/api/v1/fx/history', {
    schema: {
      querystring: {
        type: 'object',
        additionalProperties: false,
        required: ['base', 'quote'],
        properties: {
          base: { type: 'string', enum: fxCurrencies },
          quote: { type: 'string', enum: fxCurrencies },
          period: { type: 'string', enum: fxPeriods, default: '1M' },
        },
      },
    },
  }, async (request, reply) => {
    const { base, quote, period } = request.query
    const pair = `${base}/${quote}`
    if (base === quote) return reply.code(400).send({ code: 'UNSUPPORTED_CURRENCY_PAIR' })
    return providerHealth.observe('fx', () => fx.history(pair, period))
  })

  app.get('/api/v1/economy/korea', { schema: { querystring: noQuery } }, () => providerHealth.observe('ecos', ecos))

  const searchTerm = { type: 'string', minLength: 1, maxLength: 64, pattern: '^[^\\s].*$' }
  app.get('/api/v1/disclosures/kr', {
    schema: { querystring: {
      type: 'object', additionalProperties: false,
      oneOf: [
        { required: ['q'], not: { anyOf: [{ required: ['corpCode'] }, { required: ['year'] }, { required: ['period'] }] } },
        { required: ['corpCode'], not: { anyOf: [{ required: ['q'] }, { required: ['page'] }] }, dependencies: { period: ['year'], year: ['period'] } },
      ],
      properties: {
        q: searchTerm,
        page: { type: 'integer', minimum: 1, maximum: 100000 },
        corpCode: { type: 'string', pattern: '^[0-9]{8}$' },
        year: { type: 'string', pattern: '^(201[5-9]|20[2-9][0-9])$' },
        period: { type: 'string', enum: Object.keys(dartPeriods) },
      },
    } },
  }, request => providerHealth.observe('dart', () => dart(request.query)))

  if (membership && dart.collectFinancials) {
    app.post('/api/v1/financials/kr/:symbol/collect', {
      config: { access: 'admin' },
      schema: { querystring: noQuery, params: {
        type: 'object', additionalProperties: false, required: ['symbol'],
        properties: { symbol: { type: 'string', pattern: '^[0-9A-Z]{6}$' } },
      } },
    }, request => dart.collectFinancials(request.params.symbol))
  }

  const readFinancials = dart.readCachedFinancials ?? dart.collectFinancials?.readCached
  if (membership && readFinancials && memberKrx?.cachedMarketObservation) {
    async function readMarket(symbol) {
      const issue = await memberKrx.cachedIssue(symbol)
      const observation = issue ? await memberKrx.cachedMarketObservation(issue) : null
      // A single observation does not establish the issuer's complete issue set.
      return { currency: 'KRW', coverage: { status: 'unverified' }, issues: observation ? [observation] : [] }
    }
    const fundamentals = createFundamentalsProvider({ readFinancials, readMarket })
    if (financialStorageEnabled && membership.stageFundamentals) {
      const sync = createFinancialStorage({ readFinancials, readMarket,
        stage: payload => membership.stageFundamentals(payload) })
      app.post('/api/v1/financials/kr/:symbol/storage-sync', {
        config: { access: 'admin' },
        schema: { querystring: noQuery, params: {
          type: 'object', additionalProperties: false, required: ['symbol'],
          properties: { symbol: { type: 'string', pattern: '^[0-9A-Z]{6}$' } },
        } },
      }, request => sync(request.params.symbol))
    }
    app.get('/api/v1/financials/kr/:symbol/fundamentals', {
      config: { access: 'admin' },
      schema: {
        params: { type: 'object', additionalProperties: false, required: ['symbol'],
          properties: { symbol: { type: 'string', pattern: '^[0-9A-Z]{6}$' } } },
        querystring: { type: 'object', additionalProperties: false,
          properties: { asOf: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } } },
      },
    }, request => fundamentals(request.params.symbol, request.query.asOf))
  }

  app.get('/api/v1/market/snapshot', {
    schema: { querystring: noQuery },
  }, async (request, reply) => {
    if (localIndexResearch && isLocalResearchRequest(request)) {
      return sendMarket(reply, 'snapshot:local', policies.snapshot, localIndexResearch)
    }
    if (memberSnapshot) return sendMarket(reply, 'snapshot:member', policies.snapshot, memberSnapshot)
    return sendMarket(reply, 'snapshot', policies.snapshot, provider?.snapshot ?? unavailableSnapshot)
  })

  if (membership) app.post('/api/v1/market/watchlist/observations', {
    schema: { querystring: noQuery, body: {
      type: 'object', additionalProperties: false, required: ['items'],
      properties: { items: { type: 'array', minItems: 1, maxItems: 20, items: favoriteSchema } },
    } },
  }, async request => {
    const { items } = request.body
    const krx = krxFor(request)
    const symbols = [...new Set(items.filter(item => item.market === 'KR').map(item => item.symbol))]
    const domestic = krx && symbols.length ? await Promise.allSettled(['KOSPI', 'KOSDAQ'].map(market =>
      krx.stocks({ market, symbols }))) : []
    const stocks = domestic.flatMap(result => result.status === 'fulfilled' ? result.value.items : [])
    return { items: await Promise.all(items.map(async item => {
      if (item.market === 'KR') {
        const matches = stocks.filter(stock => stock.symbol === item.symbol)
        if (matches.length !== 1) return { listing: item }
        const { name, market, quote } = matches[0]
        const catalog = domestic.find(result => result.status === 'fulfilled' && result.value.market === market)?.value
        return { listing: item, name, segment: market, currency: 'KRW', quote,
          regular: catalog?.trades, afterHours: catalog?.afterHours }
      }
      const quote = (await memberUs?.stock(item.symbol).catch(() => null))?.quote
      return { listing: item, ...(quote && {
        currency: 'USD',
        quote: { price: quote.close, changePercent: quote.changePercent, tradingDate: quote.tradingDate },
      }) }
    })) }
  })

  app.get('/api/v1/market/kr/stocks', {
    schema: { querystring: {
      type: 'object', required: ['market'], additionalProperties: false,
      not: { required: ['q', 'symbol'] },
      properties: {
        market: { enum: ['KOSPI', 'KOSDAQ'] },
        q: { type: 'string', minLength: 1, maxLength: 64, pattern: '\\S' },
        symbol: { type: 'string', pattern: '^[0-9A-Z]{6}$' },
      },
    } },
  }, async (request, reply) => {
    const krx = krxFor(request)
    if (!krx) {
      return reply.code(503).send({ code: 'KRX_LOCAL_PROVIDER_DISABLED' })
    }
    return krx.stocks(request.query)
  })

  app.get('/api/v1/market/kr/stocks/:symbol/history', {
    schema: { querystring: noQuery, params: { type: 'object', required: ['symbol'],
      properties: { symbol: { type: 'string', pattern: '^[0-9A-Z]{6}$' } } } },
  }, async (request, reply) => {
    const krx = krxFor(request)
    if (!krx) return reply.code(503).send({ code: 'KRX_LOCAL_PROVIDER_DISABLED' })
    const result = await krx.stockHistory(request.params.symbol)
    return result ?? reply.code(404).send({ code: 'KRX_LISTING_NOT_FOUND' })
  })

  app.get('/api/v1/market/kr/overview', {
    schema: { querystring: noQuery },
  }, async (request, reply) => {
    const krx = krxFor(request)
    if (!krx) return reply.code(503).send({ code: 'KRX_LOCAL_PROVIDER_DISABLED' })
    return krx.overview()
  })

  const usStockSchema = {
    querystring: noQuery,
    params: { type: 'object', required: ['symbol'], properties: { symbol: usTickerSchema } },
  }
  app.get('/api/v1/market/us/stocks/:symbol/history', { schema: usStockSchema }, async request =>
    memberUs ? memberUs.stock(request.params.symbol) : { status: 'unavailable', reason: 'provider-not-configured' })
  const limitUsRequests = memberUs && app.createRateLimit({
    max: 3, keyGenerator: request => 'us-collection:' + request.memberUser.id,
  })
  app.post('/api/v1/market/us/stocks/:symbol/requests', { schema: usStockSchema }, async (request, reply) => {
    if (!memberUs) return { status: 'unavailable', reason: 'provider-not-configured' }
    const limit = await limitUsRequests(request)
    if (limit.isExceeded) return reply.header('retry-after', Math.max(1, Math.ceil(limit.ttl / 1000)))
      .code(429).send({ code: 'US_COLLECTION_RATE_LIMITED' })
    return memberUs.request(request.params.symbol)
  })

  app.get('/api/v1/market/us/indices/:id/history', {
    schema: { querystring: noQuery, params: { type: 'object', required: ['id'],
      properties: { id: { enum: marketIndices.filter(index => index.market === 'US').map(index => index.id) } } } },
  }, async request => memberUs ? memberUs.indexAnalysis(marketIndices.find(index => index.id === request.params.id).symbol)
    : { status: 'unavailable', reason: 'provider-not-configured' })

  app.get('/api/v1/market/history', {
    schema: {
      querystring: {
        type: 'object',
        additionalProperties: false,
        required: ['symbolId'],
        properties: {
          symbolId: { type: 'string', minLength: 1, maxLength: 32, pattern: '^[A-Za-z0-9_-]+$' },
          period: { type: 'string', enum: periods, default: '1M' },
        },
      },
    },
  }, async (request, reply) => {
    const { symbolId, period } = request.query
    const quote = marketIndices.find(item => item.id === symbolId)
    if (!quote) return reply.code(404).send({ error: 'Index not found' })

    if (quote.market === 'US' && memberUs) {
      return sendMarket(reply, `history:us:${symbolId}:${period}`, policies.history,
        () => memberUs.history(quote.symbol, period))
    }
    if (!provider?.history) return []
    return sendMarket(reply, `history:${symbolId}:${period}`, policies.history,
      signal => provider.history(quote, period, signal))
  })

  return app
}

export function registerKrxCollector(app, collector, intervalMs = 60_000) {
  const shutdown = new AbortController()
  let timer
  let pending
  const collect = () => {
    if (shutdown.signal.aborted || pending) return
    pending = Promise.resolve().then(() => collector.collect(shutdown.signal))
      .catch(() => app.log.warn('KRX collection failed'))
      .finally(() => { pending = undefined })
  }
  app.addHook('onReady', async () => {
    collect()
    timer = setInterval(collect, intervalMs)
    timer.unref()
  })
  app.addHook('preClose', async () => {
    clearInterval(timer)
    shutdown.abort()
    await pending
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const privateFred = process.env.FRED_PRIVATE_MODE === '1'
    if (!privateFred && process.env.DART_FINANCIAL_CACHE_DIR) {
      // Probe from the live service context before starting collectors or serving health.
      await verifyDartFinancialCache(process.env.DART_FINANCIAL_CACHE_DIR)
    }
    const research = !privateFred && process.env.FINANCE_LOCAL_INDEX_RESEARCH === '1'
      ? await import('../research/market-data/provider.mjs') : null
    const krx = !privateFred && process.env.FINANCE_LOCAL_KRX === '1' ? createKrxProvider() : undefined
    const memberUs = privateFred ? undefined : configureMemberUsMarket()
    const providerHealth = createProviderHealth({ configured: {
      krx: process.env.FINANCE_MEMBER_KRX === '1' || Boolean(krx), yfinance: Boolean(memberUs),
      ecos: Boolean(process.env.ECOS_API_KEY?.trim()), dart: Boolean(process.env.DART_API_KEY?.trim()), 'kr-intraday': false,
    } })
    const memberKrx = privateFred ? undefined : configureMemberKrx({ log: entry => {
      console.info(JSON.stringify(entry))
      providerHealth.krx(entry)
    } })
    if (krx && memberKrx) throw new Error('Local and member KRX modes are mutually exclusive')
    const app = await buildApp(privateFred ? {
      privateOnly: true,
      getEconomyIndicators: createFredProvider(),
      privateAccessToken: process.env.FINANCE_PRIVATE_API_TOKEN,
    } : {
      membership: createMembership(),
      financialStorageEnabled: process.env.FINANCE_STORAGE_SYNC === '1',
      ociMonitorWeb: {
        username: process.env.OCI_MONITOR_WEB_USER,
        passwordHash: process.env.OCI_MONITOR_WEB_PASSWORD_HASH,
      },
      ociMonitorStatus: {
        token: process.env.OCI_MONITOR_READ_TOKEN,
        filename: process.env.OCI_MONITOR_STATUS_FILE,
        ownerUid: /^\d+$/.test(process.env.OCI_MONITOR_STATUS_OWNER_UID ?? '')
          ? Number(process.env.OCI_MONITOR_STATUS_OWNER_UID) : undefined,
      },
      providerHealth,
      memberFred: configureMemberFred(),
      ...((process.env.DART_FINANCIAL_SAMPLE === '1' || process.env.FINANCE_STORAGE_SYNC === '1') && memberKrx && {
        dart: createDartProvider({ issueFor: symbol => memberKrx.cachedIssue(symbol),
          financialCollectionEnabled: process.env.DART_FINANCIAL_SAMPLE === '1' }),
      }),
      localKrx: krx,
      memberKrx,
      memberUs,
      localIndexResearch: research || krx ? createIndexSnapshot(research?.createResearchProvider(), krx) : undefined,
    })
    const collector = memberKrx ?? krx
    if (collector) registerKrxCollector(app, collector)
    await app.listen({ host: '127.0.0.1', port: privateFred ? 3001 : 3000 })
    let stopping
    const shutdown = () => {
      stopping ??= app.close().catch(() => {
        app.log.error('Finance API shutdown failed')
        process.exitCode = 1
      })
    }
    process.once('SIGTERM', shutdown)
    process.once('SIGINT', shutdown)
  } catch {
    console.error('Finance API startup failed')
    process.exitCode = 1
  }
}
