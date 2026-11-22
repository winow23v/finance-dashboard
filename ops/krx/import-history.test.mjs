import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { importHistory } from './import-history.mjs'

test('verified 304-session import refuses conflicts, adds only missing files and can be rerun', async t => {
  const root = await mkdtemp(join(tmpdir(), 'krx-import-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'source')
  const destination = join(root, 'destination')
  await Promise.all([mkdir(source), mkdir(destination)])
  let session = 0
  for (const day = new Date('2025-08-22'); day <= new Date('2026-11-20'); day.setUTCDate(day.getUTCDate() + 1)) {
    if ([0, 6].includes(day.getUTCDay())) continue
    const date = day.toISOString().slice(0, 10)
    const traded = session++ < 304
    for (const [market, codes] of Object.entries({ KOSPI: ['005930', '000660'], KOSDAQ: ['263860'] })) {
      const rows = traded ? codes.map(code => [code, 100, 102, 99, 101, 1000]) : []
      await writeFile(join(source, `ohlcv-${market}-${date}.json`), JSON.stringify({ date, rows }))
    }
  }
  const manifest = await importHistory({ source })
  assert.equal(manifest.sessionsPerMarket, 304)
  assert.equal(manifest.files, 652)
  const options = { source, destination, apply: true, expectedSha: manifest.sourceSha256 }
  await assert.rejects(importHistory({ ...options, expectedSha: '0'.repeat(64) }), /SHA-256 mismatch/)
  const conflict = join(destination, 'ohlcv-KOSPI-2025-08-22.json')
  await writeFile(conflict, 'existing file')
  const blocked = await importHistory(options)
  assert.equal(blocked.different, 1)
  assert.equal(blocked.imported, 0)
  assert.deepEqual(await readdir(destination), ['ohlcv-KOSPI-2025-08-22.json'])
  assert.equal(await readFile(conflict, 'utf8'), 'existing file')
  await unlink(conflict)
  assert.equal((await importHistory(options)).imported, 652)
  const repeated = await importHistory(options)
  assert.equal(repeated.imported, 0)
  assert.equal(repeated.identical, 652)
})
