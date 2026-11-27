import { randomBytes, scryptSync } from 'node:crypto'
import { readFileSync } from 'node:fs'

const password = readFileSync(0)
if (password.length < 24 || password.length > 256) {
  process.stderr.write('Use a random password of 24–256 bytes.\n')
  process.exitCode = 1
} else {
  const salt = randomBytes(16)
  const hash = scryptSync(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 48 * 1024 ** 2 })
  process.stdout.write(`OCI_MONITOR_WEB_PASSWORD_HASH=${salt.toString('hex')}:${hash.toString('hex')}\n`)
  password.fill(0)
}
