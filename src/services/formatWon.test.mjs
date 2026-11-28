import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatWon } from './formatWon.ts'

test('formats the signed presentation without mutating or coercing the original amount to a float', () => {
  assert.equal(formatWon(null), '미확인')
  assert.equal(formatWon(0), '0원')
  assert.equal(formatWon(9999), '9,999원')
  assert.equal(formatWon('9999.95'), '1만 원')
  assert.equal(formatWon(12345), '1.23만 원')
  assert.equal(formatWon(-125500000), '−1.26억 원')
  assert.equal(formatWon('123456789012345678901.23'), '123,456,789조 원')
})
test('rounds before promoting the display unit and suppresses trailing zeros', () => {
  assert.equal(formatWon(99_999_999), '1억 원')
  assert.equal(formatWon(995_000_000_000), '9,950억 원')
  assert.equal(formatWon(999_999_999_999), '1조 원')
  assert.equal(formatWon(15_000_000_000), '150억 원')
})
