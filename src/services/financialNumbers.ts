const missing = '자료 부족'
function truncating(options: Intl.NumberFormatOptions) {
  const settings = { ...options, roundingMode: 'trunc' }
  return new Intl.NumberFormat('ko-KR', settings)
}

type Precision = 0 | 1 | 2 | 4
const formats = {
  0: truncating({ maximumFractionDigits: 0 }),
  1: truncating({ minimumFractionDigits: 1, maximumFractionDigits: 1 }),
  2: truncating({ minimumFractionDigits: 2, maximumFractionDigits: 2 }),
  4: truncating({ minimumFractionDigits: 2, maximumFractionDigits: 4 }),
}
const volumeTick = truncating({ maximumFractionDigits: 4 })
const fine = truncating({ maximumSignificantDigits: 5 })
const scientific = truncating({ notation: 'scientific', maximumSignificantDigits: 4 })

export function financialNumber(value: number | null | undefined, digits: Precision = 2, signed = false) {
  if (value == null || !Number.isFinite(value)) return missing
  const amount = Math.abs(value)
  const format = amount > 0 && amount < 10 ** -Math.min(digits, 2) ? (amount < 1e-7 ? scientific : fine) : formats[digits]
  return (value < 0 ? '-' : value > 0 && signed ? '+' : '') + format.format(amount)
}

export function financialPercent(value: number | null | undefined, signed = false) {
  return value == null || !Number.isFinite(value) ? missing : financialNumber(value, 2, signed) + '%'
}

export function shareVolume(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value) || value < 0) return missing
  if (value >= 100_000_000) return formats[0].format(Math.trunc(value) / 100_000_000) + '억 주'
  if (value >= 10_000) return formats[0].format(Math.trunc(value) / 10_000) + '만 주'
  return financialNumber(value, 0) + '주'
}

export function shareVolumeAxis(value: number) {
  if (!Number.isFinite(value) || value < 0) return missing
  if (value >= 100_000_000) return volumeTick.format(value / 100_000_000) + '억'
  if (value >= 10_000) return volumeTick.format(value / 10_000) + '만'
  return financialNumber(value, 0)
}

export function financialRate(value: number, quote: string, signed = false) {
  return financialNumber(value, quote === 'KRW' ? 2 : 4, signed)
}

export function financialAxis(value: number, digits: Precision = 2) {
  if (!Number.isFinite(value)) return missing
  if (Math.abs(value) >= 100_000_000) return financialNumber(value / 100_000_000, 1) + '억'
  if (Math.abs(value) >= 10_000) return financialNumber(value / 10_000, 1) + '만'
  return financialNumber(value, digits)
}
