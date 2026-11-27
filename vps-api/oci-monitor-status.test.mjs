import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { chmod, link, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import test from 'node:test'
import { buildApp } from './server.mjs'

const url = '/api/v1/monitor/oci/status'
const token = randomBytes(32).toString('hex')
const auth = { authorization: `Bearer ${token}`, 'x-forwarded-proto': 'https' }

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'oci-monitor-test-'))
  const filename = join(directory, 'status.json')
  t.after(() => rm(directory, { recursive: true, force: true }))
  const app = await buildApp({
    logger: false,
    ociMonitorStatus: { token, filename, ownerUid: process.getuid(), ...options },
    membership: { verify: async () => null },
  })
  t.after(() => app.close())
  return { app, filename }
}

const writeSnapshot = (filename, value) => writeFile(filename, value, { mode: 0o640 })

function sample(minutesAgo = 5, lastCheckFailed = false, status = 'WAITING_ELIGIBILITY') {
  return {
    schema_version: 1,
    region: 'ap-chuncheon-1',
    arm: { available_ocpus: 2, available_memory_gb: 12, target_ocpus: 2, target_memory_gb: 12,
      shape_available: true, free_eligibility_verified: false, topic: 'test-private-topic' },
    provisioning: { status, attempts: 0, auto_create_enabled: false, created: status === 'COMPLETED', block_reason: 'test-private-reason' },
    monitor: { last_success_at: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
      last_check_failed: lastCheckFailed },
    host: { cpu_usage_percent: 2, ip: '192.0.2.1' },
    private_key: 'test-private-key',
  }
}

test('monitor uses dedicated authentication, rejects HTTP, query strings and other methods', async t => {
  const { app, filename } = await fixture(t)
  await writeSnapshot(filename, JSON.stringify(sample()))
  const request = (headers, method = 'GET', target = url) => app.inject({ url: target, headers, method })
  assert.equal((await request({ authorization: auth.authorization })).statusCode, 403)
  assert.equal((await request({ authorization: auth.authorization, forwarded: 'proto=https' })).statusCode, 403)
  assert.equal((await request({ ...auth, 'x-forwarded-proto': 'https,http' })).statusCode, 403)
  assert.equal((await app.inject({ url, headers: auth, remoteAddress: '192.0.2.1' })).statusCode, 403)
  assert.equal((await request({ 'x-forwarded-proto': 'https' })).statusCode, 401)
  assert.equal((await request({ ...auth, authorization: 'Bearer wrong' })).statusCode, 401)
  assert.equal((await request(auth, 'POST')).statusCode, 405)
  assert.equal((await request(auth, 'OPTIONS')).statusCode, 405)
  assert.equal((await request(auth, 'GET', url + '?token=ignored')).statusCode, 400)
  assert.equal((await request(auth, 'GET', '/api/v1/watchlist')).statusCode, 401)
  const response = await request(auth)
  assert.equal(response.statusCode, 200)
  assert.equal(response.headers['cache-control'], 'no-store')
  assert.equal(response.json().host.cpu_usage_percent, 2)
  assert.equal(response.json().data_status, 'fresh')
  assert.doesNotMatch(response.body, /test-private|192\.0\.2\.1/)
})

test('monitor has separate anonymous and authenticated rate limits', async t => {
  const { app } = await fixture(t)
  const anonymous = () => app.inject({ url, headers: { 'x-forwarded-proto': 'https' } })
  const client = () => app.inject({ url, headers: auth })
  for (let i = 0; i < 20; i++) assert.equal((await anonymous()).statusCode, 401)
  assert.equal((await anonymous()).statusCode, 429)
  for (let i = 0; i < 10; i++) assert.equal((await client()).statusCode, 503)
  assert.equal((await client()).statusCode, 429)
})

test('monitor reports unavailable data and distinguishes stale, critical and failed checks', async t => {
  const { app, filename } = await fixture(t)
  const request = () => app.inject({ url, headers: auth })
  assert.equal((await request()).statusCode, 503)
  await writeSnapshot(filename, '{')
  assert.equal((await request()).json().data_status, 'unavailable')
  await writeSnapshot(filename, JSON.stringify({ ...sample(), schema_version: 2 }))
  assert.equal((await request()).statusCode, 503)
  for (const [age, failed, status] of [[76, false, 'stale'], [181, false, 'critical'], [5, true, 'fresh']]) {
    await writeSnapshot(filename, JSON.stringify(sample(age, failed)))
    const data = (await request()).json()
    assert.equal(data.data_status, status)
    assert.equal(data.monitor.status, failed ? 'failed' : 'delayed')
    assert.equal(data.monitor.last_check_failed, failed)
    assert.equal(data.arm.quota_is_current, false)
    assert.ok(data.monitor.last_success_at)
  }
})

test('monitor exposes each provisioning state from temporary input', async t => {
  const { app, filename } = await fixture(t)
  for (const status of ['WAITING_ELIGIBILITY', 'CAPACITY_WAIT', 'SUBMITTING', 'UNKNOWN_RESULT',
    'PROVISIONING', 'COMPLETED', 'BLOCKED']) {
    await writeSnapshot(filename, JSON.stringify(sample(5, false, status)))
    const { provisioning } = (await app.inject({ url, headers: auth })).json()
    assert.equal(provisioning.status, status)
    assert.equal(provisioning.created, status === 'COMPLETED')
  }
})

test('snapshot requires the writer UID, a safe mode, a regular single-link file and a bounded size', async t => {
  const { app, filename } = await fixture(t)
  const wrongOwner = await fixture(t, { ownerUid: process.getuid() + 1 })
  const request = (server = app) => server.inject({ url, headers: auth })
  const contents = JSON.stringify(sample())
  await writeSnapshot(wrongOwner.filename, contents)
  assert.equal((await request(wrongOwner.app)).statusCode, 503)
  await writeSnapshot(filename + '.target', contents)
  await symlink(filename + '.target', filename)
  assert.equal((await request()).statusCode, 503)
  await rm(filename)
  await link(filename + '.target', filename)
  assert.equal((await request()).statusCode, 503)
  await rm(filename)
  await writeSnapshot(filename, contents)
  await chmod(filename, 0o660)
  assert.equal((await request()).statusCode, 503)
  await chmod(filename, 0o640)
  await writeSnapshot(filename, ' '.repeat(32 * 1024 + 1))
  assert.equal((await request()).statusCode, 503)
  await writeSnapshot(filename, contents)
  assert.equal((await request()).statusCode, 200)
})

test('COMPLETED is independent of a timestamped OCI lifecycle observation', async t => {
  const { app, filename } = await fixture(t)
  const status = sample(5, false, 'COMPLETED')
  const request = async () => (await app.inject({ url, headers: auth })).json().provisioning
  await writeSnapshot(filename, JSON.stringify(status))
  assert.equal((await request()).instance_lifecycle_state, null)
  status.provisioning.instance_lifecycle_state = 'RUNNING'
  await writeSnapshot(filename, JSON.stringify(status))
  assert.equal((await request()).instance_lifecycle_state, null)
  status.provisioning.instance_observed_at = new Date().toISOString()
  await writeSnapshot(filename, JSON.stringify(status))
  assert.equal((await request()).instance_lifecycle_state, 'RUNNING')
  assert.equal((await request()).instance_observed_at, status.provisioning.instance_observed_at)
})

test('partial quota is never labeled current and missing core fields are unavailable', async t => {
  const { app, filename } = await fixture(t)
  const status = sample()
  status.arm.available_memory_gb = null
  await writeSnapshot(filename, JSON.stringify(status))
  const request = () => app.inject({ url, headers: auth })
  assert.equal((await request()).json().arm.quota_is_current, false)
  delete status.provisioning.auto_create_enabled
  await writeSnapshot(filename, JSON.stringify(status))
  assert.equal((await request()).statusCode, 503)
})

test('auth failures and parser failures keep credentials out of logs at trace level', async t => {
  const messages = []
  const app = await buildApp({
    logger: { level: 'trace', stream: new Writable({
      write(chunk, _encoding, done) {
        messages.push(chunk.toString())
        done()
      },
    }) },
    ociMonitorStatus: { token },
  })
  t.after(() => app.close())
  const invalidToken = randomBytes(32).toString('hex')
  const response = await app.inject({ url: url + '?unexpected=value',
    headers: { ...auth, authorization: `Bearer ${invalidToken}` } })
  assert.equal(response.statusCode, 401)
  let rawResponse
  const rawPacket = Buffer.from(`GET ${url} HTTP/1.1\r\nAuthorization: Bearer ${token}\r\n`)
  app.server.emit('clientError', Object.assign(new Error('Parse Error'), {
    code: 'HPE_INVALID_HEADER_TOKEN', rawPacket,
  }), { writable: true, end: result => { rawResponse = result } })
  assert.match(rawResponse, /^HTTP\/1\.1 400 /)
  for (const secret of [token, invalidToken, 'unexpected=value', 'rawPacket']) {
    assert.equal(messages.join('').includes(secret), false)
  }
})
