import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatWon } from './formatWon.ts'

const examples = [
  [3_769_643_408_955, '3조 7,696억 원'],
  [2_423_013_753_913, '2조 4,230억 원'],
  [633_170_999_500, '6,331억 원'],
  [460_428_914_550, '4,604억 원'],
  [331_874_800_000, '3,318억 원'],
  [999_999_999_999, '9,999억 원'],
  [1_000_000_000_000, '1조 원'],
  [100_000_000_000, '1,000억 원'],
  [99_999_999_999, '999억 9,999만 원'],
  [1_250_000_000, '12억 5,000만 원'],
  [100_000_000, '1억 원'],
  [99_999_999, '9,999만 원'],
  [12_345_678, '1,234만 원'],
  [125_000, '12만 원'],
  [10_000, '1만 원'],
  [9_999, '9,999원'],
  [-125_500_000, '-1억 2,550만 원'],
  [-99_999_999, '-9,999만 원'],
  [0, '0원'],
  [null, '미확인'],
]

test('matches the Korean display rules without rounding or unit promotion', () => {
  for (const [value, expected] of examples) assert.equal(formatWon(value), expected, String(value))
})

test('truncates on both sides of unit boundaries and omits zero lower units', () => {
  for (const [value, expected] of [
    ['9999.999', '9,999원'], ['10000.001', '1만 원'], ['-0.999', '0원'],
    [100_000_001n, '1억 원'], [100_010_000n, '1억 1만 원'],
    [100_000_000_001n, '1,000억 원'], [1_000_000_000_001n, '1조 원'],
    [-1_000_100_000_001n, '-1조 1억 원'],
    ['123456789012345678901.23', '123,456,789조 123억 원'],
    ['9007199299999999', '9,007조 1,992억 원'],
  ]) assert.equal(formatWon(value), expected, String(value))
})

test('distinguishes invalid or missing values from zero', () => {
  for (const value of [undefined, NaN, Infinity, -Infinity, '', ' ', '1,000', '1e8', '1.2.3', '금액', {}, true]) {
    assert.equal(formatWon(value), '미확인')
  }
})
