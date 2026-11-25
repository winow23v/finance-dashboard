import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ecosRefreshFailed } from './ecosRefresh.ts'

const published = { status: 'published' }

test('published observations and normal non-publication do not fail an ECOS refresh', () => {
  assert.equal(ecosRefreshFailed({ data: [published, published] }), false)
  assert.equal(ecosRefreshFailed({ data: [published, { status: 'unavailable' }] }), false)
})

test('an ECOS request failure is reported with or without retained observations', () => {
  assert.equal(ecosRefreshFailed({ data: null }), true)
  assert.equal(ecosRefreshFailed({ data: [published], refreshFailed: true }), true)
})

test('a provider error in one indicator fails the refresh even when HTTP succeeds', () => {
  assert.equal(ecosRefreshFailed({ data: [
    published, { status: 'unavailable', code: 'PROVIDER_RATE_LIMITED' }, published,
  ] }), true)
})
