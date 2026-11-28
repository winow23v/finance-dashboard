import test from 'node:test'
import assert from 'node:assert/strict'
import { financialAxis, financialNumber, financialPercent, financialRate, shareVolume, shareVolumeAxis } from './financialNumbers.ts'
import { formatAnalysisPrice } from './analysisPrices.ts'
import { formatWon } from './formatWon.ts'

test('formats signed display values without rounding or producing negative zero', () => {
  assert.equal(formatAnalysisPrice(242449.42742771254, 'KRW'), '242,449원')
  assert.equal(formatAnalysisPrice(254007.98113533572, 'KRW'), '254,007원')
  assert.equal(formatAnalysisPrice(223500, 'KRW'), '223,500원')
  assert.equal(financialNumber(38.45678, 1), '38.4')
  assert.equal(financialNumber(12.3599) + '배', '12.35배')
  assert.equal(financialPercent(13.2599), '13.25%')
  assert.equal(financialNumber(-1245.3299), '-1,245.32')
  assert.equal(financialPercent(0.2999, true), '+0.29%')
  assert.equal(financialNumber(-0, 2, true), '0.00')
  assert.equal(financialNumber(1.13), '1.13')
})

test('preserves tiny nonzero observations and rejects non-finite values', () => {
  assert.equal(formatAnalysisPrice(0.00019, 'USD'), '0.00019 USD')
  assert.equal(financialNumber(-0.00000123), '-0.00000123')
  assert.match(financialNumber(1e-30), /1E-30/i)
  for (const value of [null, undefined, NaN, Infinity, -Infinity]) {
    assert.equal(financialNumber(value), '자료 부족')
    assert.equal(financialPercent(value), '자료 부족')
    assert.equal(shareVolume(value), '자료 부족')
  }
})

test('truncates share volumes without promoting boundaries and preserves won formatting', () => {
  assert.equal(shareVolume(17268762), '1,726만 주')
  assert.equal(shareVolume(18931479), '1,893만 주')
  assert.equal(shareVolume(19581236), '1,958만 주')
  assert.equal(shareVolume(9999), '9,999주')
  assert.equal(shareVolume(10000), '1만 주')
  assert.equal(shareVolume(99999999), '9,999만 주')
  assert.equal(shareVolume(100000000), '1억 주')
  assert.equal(financialAxis(199999), '19.9만')
  assert.equal(formatWon(3769643408955), '3조 7,696억 원')
})

test('keeps scenario prices, FX observations, and compact volume ticks distinguishable', () => {
  assert.deepEqual([0.5049, 0.5001, 0.5099].map(value => formatAnalysisPrice(value, 'USD')),
    ['0.5049 USD', '0.5001 USD', '0.5099 USD'])
  assert.equal(financialRate(1.08129, 'USD'), '1.0812')
  assert.equal(financialRate(1.08949, 'USD'), '1.0894')
  assert.equal(financialRate(1400.0099, 'KRW'), '1,400.00')
  assert.deepEqual([100_000_000, 125_000_000, 150_000_000].map(shareVolumeAxis), ['1억', '1.25억', '1.5억'])
})
