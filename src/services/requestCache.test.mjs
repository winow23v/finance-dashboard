import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequestCache } from './requestCache.ts'

test('browser cache shares concurrent requests, expires entries, and bounds retained responses', async () => {
  let now = 0
  let calls = 0
  const cache = createRequestCache(2, 10, () => now)
  const load = async () => ++calls
  assert.deepEqual(await Promise.all([cache.load('a', load), cache.load('a', load)]), [1, 1])
  assert.equal(await cache.load('a', load), 1)
  now = 10
  assert.equal(cache.read('a'), undefined)
  assert.equal(await cache.load('a', load), 2)
  await cache.load('b', load)
  await cache.load('c', load)
  assert.equal(cache.read('a'), undefined)
  assert.equal(cache.read('b'), 3)
})

test('a failed request can be retried without retaining the failure', async () => {
  const cache = createRequestCache(2, 100)
  await assert.rejects(cache.load('a', async () => { throw new Error('unavailable') }), /unavailable/)
  assert.equal(await cache.load('a', async () => 1), 1)
})
