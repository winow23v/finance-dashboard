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
import { createMembership, memberStatuses, uuidPattern } from './membership-provider.mjs'
import { ProviderError } from './public-provider.mjs'
import { createIndexSnapshot, marketIndices } from './market-index-provider.mjs'
import { createKrxProvider } from './krx-provider.mjs'

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

export async function buildApp({
  provider,
  localIndexResearch,
  localKrx,
  cache = createMarketCache(),
  logger = true,
  getEconomyIndicators,
  privateAccessToken,
  privateOnly = false,
  membership,
  memberFred,
  memberRateLimit = 60,
  fx = createFxProvider(),
  ecos = createEcosProvider(),
  dart = createDartProvider(),
} = {}) {
  if (getEconomyIndicators && !/^[a-f0-9]{64}$/.test(privateAccessToken ?? '')) {
    throw new Error('Private FRED access token is missing or invalid')
  }
  const privateAuthorization = getEconomyIndicators ? Buffer.from(`Bearer ${privateAccessToken}`) : null
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

  if (membership) {
    app.decorateRequest('memberUser', null)
    const limitMember = app.createRateLimit({
      max: memberRateLimit, keyGenerator: request => 'member:' + request.memberUser.id,
    })
    app.addHook('onRequest', async (request, reply) => {
      const access = request.routeOptions.config?.access
      if (request.routeOptions.config?.healthCheck || access === 'preflight') return
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
      .header('access-control-allow-methods', 'GET, HEAD, POST, PATCH, OPTIONS')
      .header('access-control-allow-headers', 'Authorization, Content-Type')
      .header('access-control-max-age', '600').code(204).send())
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

  app.get('/api/v1/fx/latest', { schema: { querystring: noQuery } }, () => fx.latest())

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
    return fx.history(pair, period)
  })

  app.get('/api/v1/economy/korea', { schema: { querystring: noQuery } }, () => ecos())

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
  }, request => dart(request.query))

  app.get('/api/v1/market/snapshot', {
    schema: { querystring: noQuery },
  }, async (request, reply) => {
    if (localIndexResearch && isLocalResearchRequest(request)) {
      return sendMarket(reply, 'snapshot:local', policies.snapshot, localIndexResearch)
    }
    return sendMarket(reply, 'snapshot', policies.snapshot, provider?.snapshot ?? unavailableSnapshot)
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
    if (!localKrx || !isLocalResearchRequest(request)) {
      return reply.code(503).send({ code: 'KRX_LOCAL_PROVIDER_DISABLED' })
    }
    return localKrx.stocks(request.query)
  })

  app.get('/api/v1/market/kr/stocks/:symbol/history', {
    schema: { querystring: noQuery, params: { type: 'object', required: ['symbol'],
      properties: { symbol: { type: 'string', pattern: '^[0-9A-Z]{6}$' } } } },
  }, async (request, reply) => {
    if (!localKrx || !isLocalResearchRequest(request)) return reply.code(503).send({ code: 'KRX_LOCAL_PROVIDER_DISABLED' })
    const result = await localKrx.stockHistory(request.params.symbol)
    return result ?? reply.code(404).send({ code: 'KRX_LISTING_NOT_FOUND' })
  })

  app.get('/api/v1/market/kr/overview', {
    schema: { querystring: noQuery },
  }, async (request, reply) => {
    if (!localKrx || !isLocalResearchRequest(request)) return reply.code(503).send({ code: 'KRX_LOCAL_PROVIDER_DISABLED' })
    return localKrx.overview()
  })

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

    if (!provider?.history) return []
    return sendMarket(reply, `history:${symbolId}:${period}`, policies.history,
      signal => provider.history(quote, period, signal))
  })

  return app
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const privateFred = process.env.FRED_PRIVATE_MODE === '1'
    const research = !privateFred && process.env.FINANCE_LOCAL_INDEX_RESEARCH === '1'
      ? await import('../research/market-data/provider.mjs') : null
    const krx = !privateFred && process.env.FINANCE_LOCAL_KRX === '1' ? createKrxProvider() : undefined
    const app = await buildApp(privateFred ? {
      privateOnly: true,
      getEconomyIndicators: createFredProvider(),
      privateAccessToken: process.env.FINANCE_PRIVATE_API_TOKEN,
    } : {
      membership: createMembership(),
      memberFred: configureMemberFred(),
      localKrx: krx,
      localIndexResearch: research || krx ? createIndexSnapshot(research?.createResearchProvider(), krx) : undefined,
    })
    let timer
    if (krx) app.addHook('onClose', async () => clearInterval(timer))
    await app.listen({ host: '127.0.0.1', port: privateFred ? 3001 : 3000 })
    if (krx) {
      const collect = () => { void krx.collect().catch(() => app.log.warn('KRX collection failed')) }
      collect()
      timer = setInterval(collect, 60_000)
      timer.unref()
    }
  } catch {
    console.error('Finance API startup failed')
    process.exitCode = 1
  }
}
