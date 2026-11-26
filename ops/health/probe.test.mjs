import assert from 'node:assert/strict'
import test from 'node:test'
import { probeApiHealth } from './probe.mjs'

test('external API health probe verifies the health payload and never emits URLs or body content', async () => {
  const target = 'https://health.fixture.test/health'
  const success = await probeApiHealth(target, { fetchImpl: async (url, options) => {
    assert.equal(String(url), target)
    assert.equal(options.redirect, 'error')
    assert.equal(options.headers.Authorization, undefined)
    return Response.json({ status: 'ok' })
  } })
  assert.deepEqual([success.status, success.httpStatus, success.mode], ['Healthy', 200, 'test'])
  const fail = await probeApiHealth(target, { fetchImpl: async () => new Response('private upstream body', { status: 503 }) })
  assert.deepEqual([fail.status, fail.httpStatus, fail.errorCode], ['Unavailable', 503, 'HEALTH_HTTP_ERROR'])
  assert.doesNotMatch(JSON.stringify(fail), /private|fixture\.test/)
  await assert.rejects(probeApiHealth(target + '?key=sample', { fetchImpl: () => assert.fail('must not fetch') }))
  const invalid = await probeApiHealth(target, { fetchImpl: async () => Response.json({ status: 'degraded' }) })
  assert.equal(invalid.errorCode, 'HEALTH_INVALID_RESPONSE')
})
