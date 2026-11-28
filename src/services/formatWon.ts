const integer = new Intl.NumberFormat('ko-KR')
const units = [[1_000_000_000_000n, '조'], [100_000_000n, '억'], [10_000n, '만']] as const

export function formatWon(value: number | string | bigint | null | undefined): string {
  if (value == null || typeof value === 'number' && !Number.isFinite(value)) return '미확인'
  const text = typeof value === 'number' && !Number.isInteger(value)
    ? value.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 20 })
    : typeof value === 'number' ? BigInt(value).toString() : String(value)
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text)
  if (!match) return '미확인'
  const [, sign, whole, fraction = ''] = match
  const scale = 10n ** BigInt(fraction.length)
  const amount = BigInt(whole + fraction)
  const prefix = sign && amount ? '−' : ''
  if (amount * 2n >= 19_999n * scale) {
    const index = units.findIndex(([unit]) => amount >= unit * scale)
    let [unit, label] = units[index < 0 ? units.length - 1 : index]
    let denominator = unit * scale
    let precision = amount >= 100n * denominator ? 1n : amount >= 10n * denominator ? 10n : 100n
    let rounded = (amount * precision + denominator / 2n) / denominator
    if (index > 0 && rounded * unit >= units[index - 1][0] * precision) {
      ;[unit, label] = units[index - 1]
      denominator = unit * scale
      precision = 100n
      rounded = (amount * precision + denominator / 2n) / denominator
    }
    if (rounded >= precision) {
      const tail = String(rounded % precision).padStart(String(precision).length - 1, '0').replace(/0+$/, '')
      return prefix + integer.format(rounded / precision) + (tail ? '.' + tail : '') + label + ' 원'
    }
  }
  return prefix + integer.format(BigInt(whole)) + (fraction.replace(/0+$/, '') ? '.' + fraction.replace(/0+$/, '') : '') + '원'
}
