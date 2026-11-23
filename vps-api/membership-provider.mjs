import { ProviderError } from './public-provider.mjs'

export const memberStatuses = ['pending', 'approved', 'rejected', 'suspended']
export const uuidPattern = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
const uuid = new RegExp(uuidPattern)
const columns = 'user_id,email,status,created_at,reviewed_at,reviewed_by'
const pageSize = 25

export function createMembership({
  url = process.env.SUPABASE_URL,
  publicKey = process.env.SUPABASE_PUBLISHABLE_KEY,
  secretKey = process.env.SUPABASE_SECRET_KEY,
  adminId = process.env.FINANCE_ADMIN_USER_ID,
  fetchImpl = fetch,
} = {}) {
  const origin = new URL(url ?? 'https://invalid.invalid')
  if (!url || origin.protocol !== 'https:' || origin.username || origin.password ||
    origin.pathname !== '/' || origin.search || origin.hash || !publicKey?.startsWith('sb_publishable_') ||
    !secretKey?.startsWith('sb_secret_') || !uuid.test(adminId ?? '')) {
    throw new Error('Invalid Supabase membership configuration')
  }
  adminId = adminId.toLowerCase()

  async function send(path, options) {
    const response = await fetchImpl(new URL(path, origin), {
      ...options, signal: AbortSignal.timeout(5000), redirect: 'error', cache: 'no-store',
    }).catch(() => { throw new ProviderError(503, 'MEMBERSHIP_UNAVAILABLE') })
    if (path === '/auth/v1/user' && [400, 401, 403].includes(response.status)) return null
    if (!response.ok) throw new ProviderError(503, 'MEMBERSHIP_UNAVAILABLE')
    if (response.status === 204 || options.headers?.Prefer?.includes('return=minimal')) return null
    return response.json().catch(() => { throw new ProviderError(503, 'MEMBERSHIP_UNAVAILABLE') })
  }

  function rest(resource, query, { method = 'GET', body, prefer } = {}) {
    return send('/rest/v1/' + resource + '?' + new URLSearchParams(query), {
      method,
      headers: {
        apikey: secretKey,
        ...(body && { 'Content-Type': 'application/json' }),
        ...(prefer && { Prefer: prefer }),
      },
      ...(body && { body: JSON.stringify(body) }),
    })
  }

  const table = (query, options) => rest('finance_members', query, options)

  async function verify(token) {
    let claims
    try { claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')) }
    catch { return null }
    const audiences = Array.isArray(claims?.aud) ? claims.aud : [claims?.aud]
    if (claims?.iss !== origin.origin + '/auth/v1' || !audiences.includes('authenticated') ||
      claims.role !== 'authenticated' || !Number.isSafeInteger(claims.exp) ||
      claims.exp <= Math.floor(Date.now() / 1000) || typeof claims.sub !== 'string' || !uuid.test(claims.sub)) return null
    // The decoded claims only reject out-of-scope tokens. Supabase verifies the signature.

    const user = await send('/auth/v1/user', {
      headers: { apikey: publicKey, Authorization: 'Bearer ' + token },
    })
    if (!user || user.id !== claims.sub || !uuid.test(user.id) || user.is_anonymous || !user.email_confirmed_at ||
      typeof user.email !== 'string' || !user.email || user.app_metadata?.provider !== 'google') return null
    return { id: user.id.toLowerCase(), email: user.email }
  }

  async function read(id) {
    const rows = await table({ select: columns, user_id: 'eq.' + id, limit: '1' })
    if (!Array.isArray(rows) || rows.some(row => row.user_id !== id || !memberStatuses.includes(row.status))) {
      throw new ProviderError(503, 'MEMBERSHIP_UNAVAILABLE')
    }
    return rows[0]
  }

  return {
    verify,
    async watchlist(id) {
      const items = await rest('rpc/finance_read_watchlist', {}, {
        method: 'POST', body: { member_id: id },
      })
      if (!Array.isArray(items)) throw new ProviderError(503, 'MEMBERSHIP_UNAVAILABLE')
      return items
    },
    async addFavorites(id, items) {
      await rest('finance_member_watchlist', { on_conflict: 'user_id,market,symbol' }, {
        method: 'POST', body: items.map(({ market, exchange, symbol }) => ({ user_id: id, market, exchange, symbol })),
        prefer: 'resolution=ignore-duplicates,return=minimal',
      })
    },
    async deleteFavorite(id, { market, exchange, symbol }) {
      await rest('finance_member_watchlist', {
        user_id: 'eq.' + id, market: 'eq.' + market, exchange: 'eq.' + exchange, symbol: 'eq.' + symbol,
      }, { method: 'DELETE', prefer: 'return=minimal' })
    },
    read,
    isAdmin: id => id === adminId,
    async register(user) {
      const member = await read(user.id)
      if (member) return member
      await table({ on_conflict: 'user_id' }, {
        method: 'POST', body: { user_id: user.id, email: user.email },
        prefer: 'resolution=ignore-duplicates,return=minimal',
      })
      const registered = await read(user.id)
      if (!registered) throw new ProviderError(503, 'MEMBERSHIP_UNAVAILABLE')
      return registered
    },
    async list(page, { status, email } = {}) {
      const rows = await table({ select: columns, order: 'created_at.desc,user_id.asc',
        limit: String(pageSize + 1), offset: String((page - 1) * pageSize),
        ...(status && { status: 'eq.' + status }), ...(email && { email: 'eq.' + email }),
      })
      if (!Array.isArray(rows)) throw new ProviderError(503, 'MEMBERSHIP_UNAVAILABLE')
      return { members: rows.slice(0, pageSize), more: rows.length > pageSize }
    },
    async update(id, status, expectedStatus, reviewer) {
      const rows = await table({ user_id: 'eq.' + id, status: 'eq.' + expectedStatus, select: columns }, {
        method: 'PATCH', body: { status, reviewed_by: reviewer, reviewed_at: new Date().toISOString() },
        prefer: 'return=representation',
      })
      if (!Array.isArray(rows)) throw new ProviderError(503, 'MEMBERSHIP_UNAVAILABLE')
      return rows[0]
    },
  }
}
