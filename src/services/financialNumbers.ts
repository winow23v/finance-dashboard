const missing = '자료 부족'
function truncating(options: Intl.NumberFormatOptions) {
  const settings = { ...options, roundingMode: 'trunc' }
  return new Intl.NumberFormat('ko-KR', settings)
}

const fixed = [0, 1, 2].map(digits => truncating({
  minimumFractionDigits: digits, maximumFractionDigits: digits,
}))
const fine = truncating({ maximumSignificantDigits: 5 })
const scientific = truncating({ notation: 'scientific', maximumSignificantDigits: 4 })

export function financialNumber(value: number | null | undefined, digits: 0 | 1 | 2 = 2, signed = false) {
  if (value == null || !Number.isFinite(value)) return missing
  const amount = Math.abs(value)
  const format = amount > 0 && amount < 10 ** -digits ? (amount < 1e-7 ? scientific : fine) : fixed[digits]
  return (value < 0 ? '-' : value > 0 && signed ? '+' : '') + format.format(amount)
}

export function financialPercent(value: number | null | undefined, signed = false) {
  return value == null || !Number.isFinite(value) ? missing : financialNumber(value, 2, signed) + '%'
}

export function shareVolume(value: number | null | undefined, unit = true) {
  if (value == null || !Number.isFinite(value) || value < 0) return missing
  if (value >= 100_000_000) return fixed[0].format(Math.trunc(value) / 100_000_000) + '억' + (unit ? ' 주' : '')
  if (value >= 10_000) return fixed[0].format(Math.trunc(value) / 10_000) + '만' + (unit ? ' 주' : '')
  return financialNumber(value, 0) + (unit ? '주' : '')
}

export function financialAxis(value: number, digits: 0 | 1 | 2 = 2) {
  if (!Number.isFinite(value)) return missing
  if (Math.abs(value) >= 100_000_000) return financialNumber(value / 100_000_000, 1) + '억'
  if (Math.abs(value) >= 10_000) return financialNumber(value / 10_000, 1) + '만'
  return financialNumber(value, digits)
}
