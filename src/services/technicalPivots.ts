export const pivotRadius = 2

export type Pivot = { index: number; confirmedIndex: number; value: number }

export function confirmedPivots(values: readonly (number | null)[], kind: 'high' | 'low'): Pivot[] {
  const pivots: Pivot[] = []
  for (let index = pivotRadius; index < values.length - pivotRadius; index++) {
    const value = values[index]
    if (value === null) continue
    const start = index - pivotRadius
    const confirmedIndex = index + pivotRadius
    const extreme = values.slice(start, confirmedIndex + 1).every((other, offset) =>
      start + offset === index || (other !== null && (kind === 'high' ? value > other : value < other)))
    if (extreme) pivots.push({ index, confirmedIndex, value })
  }
  return pivots
}

export type DivergenceSettings = { minDistance?: number; maxDistance?: number; tolerance?: number }

export function regularDivergences(price: readonly number[], indicator: readonly (number | null)[],
  kind: 'high' | 'low', settings: DivergenceSettings = {}) {
  const { minDistance = 5, maxDistance = 60, tolerance = 2 } = settings
  if (price.length !== indicator.length || ![minDistance, maxDistance, tolerance].every(Number.isSafeInteger)
    || minDistance < 1 || maxDistance < minDistance || tolerance < 0) return []
  const prices = confirmedPivots(price, kind)
  const oscillators = confirmedPivots(indicator, kind)
  const matches: { price: Pivot; oscillator: Pivot; availableIndex: number }[] = []
  for (const pivot of prices) {
    // Wait out the entire matching window so appending bars cannot change the match.
    const availableIndex = pivot.confirmedIndex + tolerance
    if (availableIndex >= price.length) break
    const previous = matches.at(-1)
    const oscillator = oscillators
      .filter(point => point.index > (previous?.oscillator.index ?? -1) && Math.abs(point.index - pivot.index) <= tolerance)
      .sort((a, b) => Math.abs(a.index - pivot.index) - Math.abs(b.index - pivot.index))[0]
    if (oscillator) matches.push({ price: pivot, oscillator, availableIndex })
  }
  return matches.flatMap((current, index) => {
    const previous = matches[index - 1]
    if (!previous) return []
    const distance = current.price.index - previous.price.index
    if (distance < minDistance || distance > maxDistance) return []
    const direction = kind === 'high' ? 1 : -1
    return (current.price.value - previous.price.value) * direction > 0
      && (current.oscillator.value - previous.oscillator.value) * direction < 0
      ? [{ type: kind === 'high' ? 'bearish' as const : 'bullish' as const, previous, current }]
      : []
  })
}
