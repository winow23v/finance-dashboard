import test from 'node:test'
import assert from 'node:assert/strict'
import { canReuseMarketEntry } from './marketEntryPolicy.ts'

test('reuse is bounded and cannot suppress manual refresh or retries', () => {
  const entry = { revision: 2, checkedAt: 100_000, failed: false }
  assert.equal(canReuseMarketEntry(undefined, 2, 100_000), false)
  assert.equal(canReuseMarketEntry(entry, 2, 129_999), true)
  assert.equal(canReuseMarketEntry(entry, 2, 130_000), false)
  assert.equal(canReuseMarketEntry(entry, 3, 100_001), false)
  assert.equal(canReuseMarketEntry({ ...entry, failed: true }, 2, 100_001), false)
  assert.equal(canReuseMarketEntry(entry, 2, 99_999), false)
})
