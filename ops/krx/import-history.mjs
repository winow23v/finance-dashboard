import { createHash, randomUUID } from 'node:crypto'
import { link, lstat, readFile, realpath, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const markets = { KOSPI: ['005930', '000660'], KOSDAQ: ['263860'] }
const first = '2025-08-22'
const last = '2026-11-20'
const expectedSessions = 304
const dayMs = 86_400_000

function dates() {
  const result = []
  for (let time = Date.parse(first); time <= Date.parse(last); time += dayMs) {
    const date = new Date(time)
    if (![0, 6].includes(date.getUTCDay())) result.push(date.toISOString().slice(0, 10))
  }
  return result
}

async function readRegular(path) {
  if (!(await lstat(path)).isFile()) throw new Error('Expected a regular cache file: ' + path)
  return readFile(path)
}

function verifySource(bytes, date, required) {
  const file = JSON.parse(bytes)
  if (file?.date !== date || !Array.isArray(file.rows)) throw new Error('Invalid cache date: ' + date)
  const seen = new Set()
  for (const row of file.rows) {
    if (!Array.isArray(row) || row.length !== 6) throw new Error('Invalid cache row: ' + date)
    const [symbol, open, high, low, close, volume] = row
    if (typeof symbol !== 'string' || !/^[0-9A-Z]{6}$/.test(symbol) || seen.has(symbol) ||
      ![open, high, low, close, volume].every(Number.isFinite) || low <= 0 ||
      low > Math.min(open, close) || high < Math.max(open, close) || volume <= 0) {
      throw new Error('Invalid or duplicate cache row: ' + date)
    }
    seen.add(symbol)
  }
  if (seen.size && required.some(symbol => !seen.has(symbol))) throw new Error('Missing target listing: ' + date)
  return seen.size > 0
}

async function existing(path, bytes) {
  try {
    return bytes.equals(await readRegular(path)) ? 'identical' : 'different'
  } catch (error) {
    if (error.code === 'ENOENT') return 'missing'
    throw error
  }
}

async function addMissing(target, bytes) {
  const temp = target + '.import-' + randomUUID()
  await writeFile(temp, bytes, { flag: 'wx', mode: 0o600, flush: true })
  try {
    // Linking fails atomically if Fastify or another operator created the destination first.
    try {
      await link(temp, target)
      return 'imported'
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      return existing(target, bytes)
    }
  } finally {
    await unlink(temp)
  }
}

export async function importHistory({ source, destination, apply = false, expectedSha }) {
  const from = await realpath(source)
  const to = destination ? await realpath(destination) : undefined
  if ((apply && !to) || from === to) throw new Error('Choose a different, existing destination directory')
  const hash = createHash('sha256')
  const candidates = []
  for (const [market, symbols] of Object.entries(markets)) {
    let sessions = 0
    for (const date of dates()) {
      const name = `ohlcv-${market}-${date}.json`
      const bytes = await readRegular(join(from, name))
      if (verifySource(bytes, date, symbols)) sessions++
      hash.update(name + '\0' + bytes.length + '\0').update(bytes)
      candidates.push({ name, bytes })
    }
    if (sessions !== expectedSessions) throw new Error(`Expected ${expectedSessions} sessions in ${market}, found ${sessions}`)
  }
  const report = { sourceSha256: hash.digest('hex'), first, last, sessionsPerMarket: expectedSessions,
    files: candidates.length, missing: 0, identical: 0, different: 0, imported: 0, conflicts: [] }
  if (apply && report.sourceSha256 !== expectedSha) throw new Error('Source SHA-256 mismatch')
  if (!to) return report
  for (const { name, bytes } of candidates) {
    const state = await existing(join(to, name), bytes)
    report[state]++
    if (state === 'different') report.conflicts.push(name)
  }
  if (!apply || report.different) return report
  for (const { name, bytes } of candidates) {
    const target = join(to, name)
    const state = await existing(target, bytes)
    const result = state === 'missing' ? await addMissing(target, bytes) : state
    if (result === 'imported') report.imported++
    else if (result === 'different') {
      report.different++
      report.conflicts.push(name)
      break
    }
  }
  return report
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, source, destination, expectedSha, extra] = process.argv.slice(2)
  try {
    if (!source || extra || !['verify', 'plan', 'apply'].includes(command) ||
      (command === 'verify' ? Boolean(destination) : !destination) ||
      (command === 'apply' ? !/^[a-f0-9]{64}$/.test(expectedSha ?? '') : Boolean(expectedSha))) {
      throw new Error('Usage: import-history.mjs verify SOURCE | plan SOURCE DESTINATION | apply SOURCE DESTINATION SHA256')
    }
    const report = await importHistory({ source, destination, apply: command === 'apply', expectedSha })
    console.log(JSON.stringify(report, null, 2))
    if (report.different) process.exitCode = 2
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
