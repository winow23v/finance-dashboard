import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createMembership } from './membership-provider.mjs'
import { buildApp } from './server.mjs'

const admin = '00000000-0000-4000-8000-000000000001'
const applicant = '00000000-0000-4000-8000-000000000002'
const other = '00000000-0000-4000-8000-000000000003'
const secretKey = 'sb_secret_fixture-server'
const users = { administrator: admin, applicant, notgoogle: applicant, other }
const auth = (token, claims = {}) => ({
  authorization: 'Bearer ' + token + '.' + Buffer.from(JSON.stringify({
    sub: users[token] ?? applicant, iss: 'https://example.supabase.co/auth/v1',
    aud: 'authenticated', role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 300, ...claims,
  })).toString('base64url') + '.signature',
})
const member = (id, status) => ({ user_id: id, email: id + '@example.test', status })
const financeRoutes = [
  '/api/v1/fx/latest',
  '/api/v1/fx/history?base=USD&quote=KRW',
  '/api/v1/economy/korea',
  '/api/v1/economy/indicators',
  '/api/v1/disclosures/kr?q=005930',
  '/api/v1/market/snapshot',
  '/api/v1/market/history?symbolId=kospi',
]

async function setup(t, options = {}) {
  const rows = new Map([[admin, member(admin, 'approved')], [other, member(other, 'approved')]])
  const calls = []
  let available = true
  const membership = createMembership({
    url: 'https://example.supabase.co', publicKey: 'sb_publishable_fixture-public', secretKey, adminId: admin,
    fetchImpl: async (url, request) => {
      assert.equal(url.origin, 'https://example.supabase.co')
      if (!available) return Response.json({}, { status: 503 })
      if (url.pathname === '/auth/v1/user') {
        const token = request.headers.Authorization.split(' ')[1].split('.')[0]
        const id = users[token]
        assert.equal(request.headers.apikey, 'sb_publishable_fixture-public')
        if (!id) return Response.json({}, { status: 401 })
        return Response.json({ id, email: id + '@example.test', email_confirmed_at: '2026-01-01',
          app_metadata: { provider: token === 'notgoogle' ? 'email' : 'google' },
          user_metadata: { role: 'administrator', status: 'approved' },
        })
      }
      assert.equal(url.pathname, '/rest/v1/finance_members')
      assert.equal(request.headers.apikey, secretKey)
      assert.equal(request.headers.Authorization, undefined)
      const id = url.searchParams.get('user_id')?.slice(3)
      if (request.method === 'POST') {
        const body = JSON.parse(request.body)
        assert.deepEqual(Object.keys(body).sort(), ['email', 'user_id'])
        if (!rows.has(body.user_id)) rows.set(body.user_id, member(body.user_id, 'pending'))
        return new Response(null, { status: 201 })
      }
      if (request.method === 'PATCH') {
        const row = rows.get(id)
        if (!row || url.searchParams.get('status') !== 'eq.' + row.status) return Response.json([])
        const updated = { ...row, ...JSON.parse(request.body) }
        rows.set(id, updated)
        return Response.json([updated])
      }
      return Response.json([...rows.values()].filter(row =>
        (!id || row.user_id === id) &&
        (!url.searchParams.has('status') || 'eq.' + row.status === url.searchParams.get('status')) &&
        (!url.searchParams.has('email') || 'eq.' + row.email === url.searchParams.get('email'))))
    },
  })
  const track = name => () => { calls.push(name); return { source: name } }
  const app = await buildApp({
    logger: false, membership, fx: { latest: track('FX'), history: track('FX') },
    ecos: track('ECOS'), dart: track('DART'), memberFred: track('FRED'), ...options,
  })
  t.after(() => app.close())
  return { app, calls, rows, offline: () => { available = false } }
}

test('each legacy finance route requires a verified Google token and an approved account before serving data', async t => {
  const { app, calls } = await setup(t)
  for (const url of financeRoutes) {
    assert.equal((await app.inject({ url })).statusCode, 401)
    assert.equal((await app.inject({ url, headers: auth('invalid') })).statusCode, 401)
    assert.equal((await app.inject({ url, headers: auth('notgoogle') })).statusCode, 401)
    assert.equal((await app.inject({ url, headers: auth('applicant') })).statusCode, 403)
  }
  assert.equal((await app.inject({ url: financeRoutes[0], method: 'HEAD' })).statusCode, 401)
  assert.deepEqual(calls, [])
  assert.equal((await app.inject('/health')).statusCode, 200)
  const preflight = await app.inject({ url: '/api/v1/admin/members', method: 'OPTIONS' })
  assert.equal(preflight.statusCode, 204)
  assert.match(preflight.headers['access-control-allow-headers'], /Authorization/)
  for (const url of financeRoutes) {
    const response = await app.inject({ url, headers: auth('other') })
    assert.equal(response.statusCode, 200, url)
    assert.equal(response.headers['cache-control'], 'no-store')
  }
  assert.deepEqual(calls, ['FX', 'FX', 'ECOS', 'FRED', 'DART'])
})

test('registration stays pending on repeats and administrator transitions immediately govern existing tokens', async t => {
  const { app, calls } = await setup(t)
  const pathname = '/api/v1/admin/members'
  const session = () => app.inject({ url: '/api/v1/session', headers: auth('applicant') })
  const update = (actor, status, expectedStatus, id = applicant) => app.inject({
    url: pathname + '/' + id, method: 'PATCH', headers: auth(actor), payload: { status, expectedStatus },
  })
  for (const response of await Promise.all([session(), session()])) {
    assert.equal(response.json().status, 'pending')
    assert.equal(response.json().admin, false)
  }
  assert.equal((await update('applicant', 'approved', 'pending')).statusCode, 403)
  assert.equal((await app.inject({ url: pathname, headers: auth('applicant') })).statusCode, 403)
  assert.equal((await update('other', 'approved', 'pending')).json().code, 'ADMIN_REQUIRED')
  assert.equal((await app.inject({ url: pathname, headers: auth('other') })).statusCode, 403)
  const adminList = await app.inject({ url: pathname, headers: auth('administrator') })
  assert.equal(adminList.statusCode, 200)
  assert.equal(adminList.json().members.length, 3)
  assert.equal((await app.inject({ url: financeRoutes[0], headers: auth('administrator') })).statusCode, 200)
  assert.equal((await update('administrator', 'suspended', 'approved', admin)).statusCode, 409)
  assert.equal((await update('administrator', 'approved', 'pending')).json().reviewed_by, admin)
  const duplicate = await update('administrator', 'approved', 'pending')
  assert.equal(duplicate.statusCode, 409)
  assert.equal(duplicate.json().code, 'MEMBER_STATUS_CONFLICT')
  assert.equal((await update('administrator', 'rejected', 'pending')).statusCode, 409)
  assert.equal((await session()).json().status, 'approved')
  assert.equal((await app.inject({ url: financeRoutes[0], headers: auth('applicant') })).statusCode, 200)
  for (const [next, prior] of [['suspended', 'approved'], ['rejected', 'suspended']]) {
    assert.equal((await update('administrator', next, prior)).statusCode, 200)
    assert.equal((await session()).json().status, next)
    assert.equal((await app.inject({ url: financeRoutes[0], headers: auth('applicant') })).statusCode, 403)
    assert.equal((await app.inject({ url: pathname, headers: auth('applicant') })).statusCode, 403)
  }
  assert.deepEqual(calls, ['FX', 'FX'])
})

test('the account quota is independent of client IP and auth failure is closed', async t => {
  const { app, calls, offline } = await setup(t, { memberRateLimit: 1 })
  const request = (token, ip) => app.inject({ url: financeRoutes[0], headers: auth(token), remoteAddress: ip })
  assert.equal((await request('other', '192.0.2.1')).statusCode, 200)
  const limited = await request('other', '192.0.2.2')
  assert.equal(limited.statusCode, 429)
  assert.equal(limited.json().code, 'MEMBER_RATE_LIMITED')
  assert.ok(Number(limited.headers['retry-after']) > 0)
  assert.equal((await request('administrator', '192.0.2.2')).statusCode, 200)
  offline()
  const unavailable = await request('other', '192.0.2.3')
  assert.equal(unavailable.statusCode, 503)
  assert.equal(unavailable.json().code, 'MEMBERSHIP_UNAVAILABLE')
  assert.deepEqual(calls, ['FX', 'FX'])
})

test('wrong issuer, audience, role, subject or expired tokens cannot reach finance data', async t => {
  const { app, calls } = await setup(t)
  for (const claims of [
    { iss: 'https://other.example/auth/v1' }, { aud: ['anon'] }, { role: 'anon' },
    { exp: 1 }, { sub: applicant }, { sub: '' },
  ]) {
    assert.equal((await app.inject({ url: financeRoutes[0], headers: auth('other', claims) })).statusCode, 401)
  }
  assert.deepEqual(calls, [])
})

test('administrators can filter and search and revoke approval back to pending', async t => {
  const { app } = await setup(t)
  const url = '/api/v1/admin/members'
  const adminHeaders = auth('administrator')
  assert.deepEqual((await app.inject({ url: url + '?status=pending', headers: adminHeaders })).json().members, [])
  const search = actor => app.inject({ url: url + '/search', method: 'POST', headers: auth(actor),
    payload: { email: member(other, 'approved').email, status: 'approved' } })
  assert.equal((await search('other')).statusCode, 403)
  assert.deepEqual((await search('administrator')).json().members.map(row => row.user_id), [other])
  const revoke = await app.inject({ url: url + '/' + other, method: 'PATCH', headers: adminHeaders,
    payload: { status: 'pending', expectedStatus: 'approved' } })
  assert.equal(revoke.json().status, 'pending')
  assert.equal((await app.inject({ url: financeRoutes[0], headers: auth('other') })).statusCode, 403)
  assert.deepEqual((await app.inject({ url: url + '?status=pending', headers: adminHeaders })).json().members.map(row => row.user_id), [other])
})

test('the removed US disclosures path returns no data', async t => {
  const { app } = await setup(t)
  const url = '/api/v1/disclosures/us?q=AAPL'
  assert.equal((await app.inject({ url })).statusCode, 401)
  assert.equal((await app.inject({ url, headers: auth('other') })).statusCode, 404)
})


test('an administrator can restore a suspended member and a fresh session can use finance data', async t => {
  const { app, rows } = await setup(t)
  rows.set(other, member(other, 'suspended'))
  const blocked = await app.inject({ url: financeRoutes[0], headers: auth('other') })
  assert.equal(blocked.statusCode, 403)
  const restored = await app.inject({
    method: 'PATCH', url: '/api/v1/admin/members/' + other, headers: auth('administrator'),
    payload: { status: 'approved', expectedStatus: 'suspended' },
  })
  assert.equal(restored.json().status, 'approved')
  assert.equal(restored.json().reviewed_by, admin)
  const fresh = auth('other', { exp: Math.floor(Date.now() / 1000) + 600 })
  const session = await app.inject({ url: '/api/v1/session', headers: fresh })
  assert.equal(session.json().status, 'approved')
  assert.equal(session.json().admin, false)
  assert.equal((await app.inject({ url: financeRoutes[0], headers: fresh })).statusCode, 200)
  assert.equal((await app.inject(financeRoutes[0])).statusCode, 401)
})
