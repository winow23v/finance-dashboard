import assert from 'node:assert/strict'
import { scryptSync } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { buildApp } from './server.mjs'

const origin = 'https://winow.duckdns.org'
const username = 'pickle-monitor'
const password = 'local-test-fixture-password'
const salt = Buffer.alloc(16, 7)
const passwordHash = salt.toString('hex') + ':' +
  scryptSync(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 48 * 1024 ** 2 }).toString('hex')
const csrf = html => html.match(/name="csrf" (?:type="hidden" )?value="([a-f0-9]+)"/)?.[1]
const cookies = response => [].concat(response.headers['set-cookie'] ?? [])
const cookie = (response, keyword) => cookies(response).find(value => value.includes(keyword))?.split(';')[0]

async function fixture(t, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'oci-web-test-'))
  const filename = join(directory, 'status.json')
  const app = await buildApp({ logger: false, membership: { verify: async () => null },
    ociMonitorStatus: { filename, ownerUid: process.getuid() },
    ociMonitorWeb: { username, passwordHash, ...overrides } })
  t.after(async () => {
    await app.close()
    await rm(directory, { recursive: true, force: true })
  })
  const call = (url, options = {}) => app.inject({ ...options, url, headers: {
    'x-forwarded-proto': 'https', ...options.headers,
  } })
  const form = (url, data, jar, extra = {}) => call(url, { method: 'POST',
    headers: { origin, cookie: jar, 'content-type': 'application/x-www-form-urlencoded', ...extra },
    payload: new URLSearchParams(data).toString(),
  })
  const login = async () => {
    const page = await call('/monitor/login')
    return form('/monitor/login', { username, password, csrf: csrf(page.body) }, cookie(page, 'csrf'))
  }
  return { call, form, login, filename }
}

function snapshot(ageMinutes) {
  return {
    schema_version: 1, region: 'ap-chuncheon-1',
    arm: { ad_available_ocpus: 0, ad_available_memory_gb: 0, available_ocpus: 0, available_memory_gb: 0,
      free_eligibility_verified: false, target_ocpus: 2, target_memory_gb: 12, shape_available: true },
    provisioning: { status: 'WAITING_ELIGIBILITY', created: false, attempts: 0,
      auto_create_enabled: false, block_reason: '<script>secret-code</script>' },
    monitor: { last_check_failed: false, last_success_at: new Date(Date.now() - ageMinutes * 60_000).toISOString() },
    host: { memory_available_bytes: 1024 ** 3, swap_used_bytes: 0, sampled_at: '2026-11-27T00:00:00Z' },
    topic: 'secret-topic',
  }
}

test('standard login, isolated session, stale status and logout', async t => {
  const { call, form, login, filename } = await fixture(t)
  const unauth = await call('/monitor/status')
  assert.equal(unauth.headers.location, '/monitor/login')
  const page = await call('/monitor/login')
  assert.match(page.body, /autocomplete="username".*required/)
  assert.match(page.body, /type="password" autocomplete="current-password"/)
  assert.equal(page.headers['cache-control'], 'no-store')
  assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/)
  assert.equal((await call('/monitor/login', { headers: { 'x-forwarded-proto': 'http' } })).statusCode, 403)
  const signed = await login()
  assert.equal(signed.statusCode, 303)
  assert.equal(signed.headers.location, '/monitor/status')
  assert.equal(cookies(signed).length, 2)
  assert.match(cookies(signed)[1], /Path=\/monitor; HttpOnly; Secure; SameSite=Lax; Max-Age=86400/)
  assert.doesNotMatch(cookies(signed)[1], /Domain=/)
  const jar = cookie(signed, 'session')
  const auth = { headers: { cookie: jar } }
  assert.equal((await call('/monitor/status', auth)).statusCode, 503)
  await writeFile(filename, JSON.stringify(snapshot(80)), { mode: 0o640 })
  const view = await call('/monitor/status', auth)
  assert.equal(view.statusCode, 200)
  assert.match(view.body, /stale/)
  assert.match(view.body, /0 MiB/)
  assert.match(view.body, /1.00 GiB/)
  assert.match(view.body, /<time datetime="2026-11-27T00:00:00.000Z">/)
  assert.doesNotMatch(view.body, /script|secret-topic|secret-code/)
  assert.equal((await call('/api/v1/watchlist', auth)).statusCode, 401)
  assert.notEqual((await call('/api/v1/monitor/oci/status', auth)).statusCode, 200)
  assert.equal((await form('/monitor/logout', { csrf: csrf(view.body) }, jar, { origin: 'https://wrong.example' })).statusCode, 403)
  assert.equal((await form('/monitor/logout', { csrf: 'a'.repeat(64) }, jar)).statusCode, 403)
  assert.equal((await form('/monitor/logout', { csrf: csrf(view.body) }, jar)).headers.location, '/monitor/login')
  assert.equal((await call('/monitor/status', auth)).headers.location, '/monitor/login')
})

test('login rejects origins, challenge mismatches and excessive failures', async t => {
  const { call, form } = await fixture(t)
  const page = await call('/monitor/login')
  const jar = cookie(page, 'csrf')
  const correct = { username, password, csrf: csrf(page.body) }
  assert.equal((await form('/monitor/login', correct, jar, { origin: 'https://wrong.example' })).statusCode, 403)
  assert.equal((await form('/monitor/login', { ...correct, csrf: 'a'.repeat(64) }, jar)).statusCode, 403)
  const wrong = { ...correct, password: 'wrong' }
  for (let i = 0; i < 5; i++) assert.equal((await form('/monitor/login', wrong, jar)).statusCode, 401)
  assert.equal((await form('/monitor/login', correct, jar)).statusCode, 429)
})

test('session expires, relogin rotates it and credential rotation drops old sessions', async t => {
  let clock = 0
  const first = await fixture(t, { now: () => clock, sessionTtl: 2 })
  const old = cookie(await first.login(), 'session')
  clock = 2010
  assert.equal((await first.call('/monitor/status', { headers: { cookie: old } })).headers.location, '/monitor/login')
  const next = cookie(await first.login(), 'session')
  assert.notEqual(old, next)
  const rotated = await fixture(t, { passwordHash: salt.toString('hex') + ':' + 'a'.repeat(64) })
  assert.equal((await rotated.call('/monitor/status', { headers: { cookie: next } })).headers.location, '/monitor/login')
})
