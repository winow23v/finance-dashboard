import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createResearchProvider } from './provider.mjs'

test('the research adapter reads one generation and keeps missing observations unavailable', async t => {
  const root = await mkdtemp(join(tmpdir(), 'finance-research-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const directory = join(root, 'snapshots', 'KO')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'summary.json'), JSON.stringify({
    symbol: 'KO', distribution: 'local-research-only', dataStatus: 'available',
    source: 'test', tradingDate: '2026-11-20', observedAt: '2026-11-20T21:00:00Z', nextSessionClose: '2000-01-03T21:00:00Z',
    rows: 1, raw: { close: 100, adjustmentType: 'yahoo-raw', indicators: { rsi14: null } },
    adjusted: { close: 98, adjustmentType: 'yahoo-auto-adjusted', indicators: { rsi14: null } },
  }))
  await writeFile(join(directory, 'adjusted.csv'), 'Date,Open,High,Low,Close,Volume\n2026-11-20,99,102,97,98,50\n')
  const provider = createResearchProvider(root)
  assert.equal((await provider.getQuote('KO')).quoteType, 'session-close')
  assert.equal((await provider.getQuote('KO')).dataStatus, 'stale')
  assert.equal((await provider.getHistory('KO', '2Y', 'yahoo-auto-adjusted')).bars[0].close, 98)
  assert.equal((await provider.getIndicators('KO')).raw.values.rsi14, null)
  assert.equal((await provider.getQuote('JNJ')).dataStatus, 'no-observation')
  assert.equal((await provider.getHistory('KO', 'constructor')).dataStatus, 'unsupported-period')
  assert.equal((await provider.getMarketHeatmap()).dataStatus, 'no-verified-market-cap-or-sector')
})
