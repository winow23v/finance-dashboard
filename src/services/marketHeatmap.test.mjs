import assert from 'node:assert/strict'
import { test } from 'node:test'
import { heatmapColor, heatmapTextColor, layoutHeatmap, parseMarketHeatmap } from './marketHeatmap.ts'

const day = '2026-11-20'
const source = () => ({
  label: 'Test feed', url: 'https://example.test/', collectedAt: '2026-11-20T23:00:00Z',
  refreshIntervalMs: null, publicDisplay: true, publicApiRedistribution: true,
})
const listing = (symbol, marketCap) => ({
  listing: { market: 'US', exchange: 'XNAS', symbol },
  name: symbol, sector: 'Test sector', marketCap, marketCapCurrency: 'USD', marketCapDate: day,
  classificationDate: '2026-10-01', previousTradingDate: '2026-11-19',
  quote: { value: 105, previousClose: 100, currency: 'USD', tradingDate: day,
    timeZone: 'America/New_York', observation: { kind: 'session', date: day }, change: 5, percentChange: 5 },
})
const snapshot = () => ({
  market: 'US', tradingDate: day, session: 'closed', timing: { kind: 'end-of-day' }, adjustment: 'split-adjusted',
  sources: { quote: source(), marketCap: source(), sector: source() }, listings: [listing('AAA', 60), listing('BBB', 40)],
})

test('contract accepts approved quotes with one session, positive same-currency caps and separate sources', () => {
  const data = snapshot()
  assert.equal(parseMarketHeatmap(data, 'US'), data)
  assert.equal(parseMarketHeatmap(data, 'KR'), null)
  for (const item of data.listings) item.marketCapDate = item.previousTradingDate
  assert.equal(parseMarketHeatmap(data, 'US'), data)
  data.session = 'holiday'
  assert.equal(parseMarketHeatmap(data, 'US'), data)
  data.timing = { kind: 'realtime' }
  assert.equal(parseMarketHeatmap(data, 'US'), null)
})

test('invalid rights, missing or duplicate weights, mismatched sessions and return fail closed', () => {
  for (const invalidate of [
    data => { data.sources.sector.publicApiRedistribution = false },
    data => { data.sources.quote.url = 'http://example.test/' },
    data => { delete data.listings[1].marketCap },
    data => { data.listings[1].marketCap = 0 },
    data => { data.listings[1].marketCapCurrency = 'KRW' },
    data => { data.listings[1].marketCapDate = '2026-11-19' },
    data => { data.listings[1].classificationDate = '2026-11-21' },
    data => { data.listings[1].previousTradingDate = '2026-11-18' },
    data => { data.listings[1].quote.percentChange = 99 },
    data => { data.listings[1].quote.timeZone = 'Unknown/Zone' },
    data => { data.listings[1].quote.observation = { kind: 'instant', at: '2026-11-20T03:00:00Z' } },
    data => { data.listings[1] = data.listings[0] },
    data => { data.listings = Array.from({ length: 61 }, (_, index) => listing(`TEST${index}`, 1)) },
  ]) {
    const data = snapshot()
    invalidate(data)
    assert.equal(parseMarketHeatmap(data, 'US'), null, String(invalidate))
  }
})

test('area follows market capitalization even inside a sector boundary', () => {
  const weights = { LARGE: 60, MEDIUM: 30, SMALL: 10 }
  const layout = layoutHeatmap(Object.keys(weights), name => weights[name], { x: 20, y: 40, width: 80, height: 60 })
  for (const { row, rect } of layout) {
    assert.ok(Math.abs(rect.width * rect.height - 4800 * weights[row] / 100) < 1e-9)
    assert.ok(rect.x >= 20 && rect.y >= 40 && rect.x + rect.width <= 100 && rect.y + rect.height <= 100)
  }
  assert.deepEqual(layoutHeatmap([1, 0], value => value), [])
})

test('palettes follow market direction and saturate only the color beyond 3%', () => {
  assert.equal(heatmapColor('KR', 4), '#E93636')
  assert.equal(heatmapColor('KR', -4), '#377FCF')
  assert.equal(heatmapColor('US', 7), '#2CC95C')
  assert.equal(heatmapColor('US', -7), '#E63238')
  assert.equal(heatmapColor('KR', 0), '#414B58')
  assert.equal(heatmapTextColor('#2CC95C'), '#000')
  assert.equal(heatmapTextColor('#414B58'), '#fff')
})
