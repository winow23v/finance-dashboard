import { fileURLToPath } from 'node:url'
import { createKrxProvider, memberKrxCacheDir } from './krx-provider.mjs'

const args = process.argv.slice(2)
const member = args.includes('--member')
const apply = args.includes('--apply')
const positionals = args.filter(arg => !arg.startsWith('--'))
const option = name => args.find(arg => arg.startsWith(name + '='))?.slice(name.length + 1).split(',')
const root = member ? memberKrxCacheDir() : fileURLToPath(new URL('.krx-cache/', import.meta.url))
const provider = createKrxProvider({ root, scheduledOnly: member, log: () => {} })

try {
  if (args.some(arg => arg.startsWith('--') && !['--member', '--apply', '--plan'].includes(arg) &&
      !arg.startsWith('--markets=') && !arg.startsWith('--kinds=')) ||
      (apply && args.includes('--plan')) || (apply && !positionals.length)) {
    throw new Error('Usage: krx-backfill.mjs [--member] [--apply] [--markets=KOSPI,KOSDAQ] [--kinds=trades,index] [YYYY-MM-DD ...]')
  }
  const options = {
    dates: positionals.length ? positionals : undefined,
    markets: option('--markets'), kinds: option('--kinds'),
  }
  const plan = await provider.backfillMissingDates(options)
  console.log(JSON.stringify({ root, ...plan }))
  if (apply) {
    const result = await provider.backfillMissingDates({ ...options, dryRun: false })
    console.log(JSON.stringify({ root, ...result }))
    if (result.stopped || result.outcomes.some(outcome => outcome.status === 'error')) process.exitCode = 1
  }
} catch (error) {
  console.error(JSON.stringify({ stopped: error.code ?? 'KRX_BACKFILL_FAILED', message: error.code ?? error.message }))
  process.exitCode = 1
}
