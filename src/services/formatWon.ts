const integer = new Intl.NumberFormat('ko-KR')
const trillion = 1_000_000_000_000n
const hundredMillion = 100_000_000n
const tenThousand = 10_000n

export function formatWon(value: number | string | bigint | null | undefined): string {
  let won: bigint
  if (typeof value === 'bigint') {
    won = value
  } else if (typeof value === 'number' && Number.isFinite(value)) {
    won = BigInt(Math.trunc(value))
  } else if (typeof value === 'string') {
    const match = /^(-?\d+)(?:\.\d+)?$/.exec(value)
    if (!match) return '미확인'
    won = BigInt(match[1])
  } else {
    return '미확인'
  }

  const amount = won < 0n ? -won : won
  const sign = won < 0n ? '-' : ''
  const compound = (major: bigint, majorLabel: string, minor: bigint, minorLabel: string) =>
    integer.format(major) + majorLabel + (minor ? ' ' + integer.format(minor) + minorLabel : '')

  if (amount >= trillion) {
    return sign + compound(amount / trillion, '조', amount % trillion / hundredMillion, '억') + ' 원'
  }
  if (amount >= 1_000n * hundredMillion) {
    return sign + integer.format(amount / hundredMillion) + '억 원'
  }
  if (amount >= hundredMillion) {
    return sign + compound(amount / hundredMillion, '억', amount % hundredMillion / tenThousand, '만') + ' 원'
  }
  if (amount >= tenThousand) return sign + integer.format(amount / tenThousand) + '만 원'
  return sign + integer.format(amount) + '원'
}
