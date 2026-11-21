import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createKrxProvider } from './krx-provider.mjs'
import { ProviderError } from './public-provider.mjs'

const root = new URL('.krx-cache/', import.meta.url)
await mkdir(root, { recursive: true, mode: 0o700 })
if (process.argv[2] !== '--locked') {
  // The OS releases this lock automatically when the wrapper exits.
  const result = spawnSync('flock', ['-n', fileURLToPath(new URL('backfill.flock', root)),
    process.execPath, ...process.execArgv, process.argv[1], '--locked', ...process.argv.slice(2)], { stdio: 'inherit' })
  if (result.status !== 0 && result.error) console.error('KRX backfill could not acquire a process lock')
  process.exit(result.status ?? 1)
}
const kstDay = () => new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10)
const startDay = kstDay()
const ledger = new URL('backfill-' + startDay + '.jsonl', root)
const [batch = '140', budget = '650', prior = '0'] = process.argv.slice(3)
let attempts = 0
const statuses = {}
const append = record => appendFile(ledger, JSON.stringify({ at: new Date().toISOString(), ...record }) + '\n', { mode: 0o600 })

try {
  if (![batch, budget, prior].every(value => /^\d+$/.test(value)) ||
    +batch < 1 || +batch > 145 || +budget < 1 || +budget > 10000 || +prior > +budget) {
    throw new Error('Usage: krx-backfill.mjs [requests per market, max 145] [daily budget] [earlier usage estimate]')
  }
  const contents = await readFile(ledger, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return ''
    throw error
  })
  const records = contents.split('\n').filter(Boolean).map(line => JSON.parse(line))
  const used = records.filter(line => line.event === 'request').length
  const priorUsage = Math.max(+prior, ...records.filter(line => line.event === 'prior').map(line => line.count), 0)
  await append({ event: 'prior', count: priorUsage })
  const provider = createKrxProvider({
    root: fileURLToPath(root),
    async fetchImpl(url, options) {
      if (kstDay() !== startDay || used + priorUsage + attempts >= +budget) {
        throw new ProviderError(503, 'KRX_BACKFILL_BUDGET')
      }
      const request = { endpoint: url.pathname.split('/').at(-1), date: url.searchParams.get('basDd') }
      await append({ event: 'request', ...request })
      attempts++
      try {
        const response = await fetch(url, options)
        statuses[response.status] = (statuses[response.status] ?? 0) + 1
        await append({ event: 'response', ...request, http: response.status })
        return response
      } catch (error) {
        await append({ event: 'transport-error', ...request })
        throw error
      }
    },
  })
  const result = await provider.backfill(+batch)
  await append({ event: 'summary', attempts, statuses, result })
  console.log(JSON.stringify({ day: startDay, priorUsage, previouslyJournaled: used, attempts, statuses, result }))
} catch (error) {
  console.error(JSON.stringify({ stopped: error.code ?? 'KRX_BACKFILL_FAILED', attempts, statuses }))
  process.exitCode = 1
}
