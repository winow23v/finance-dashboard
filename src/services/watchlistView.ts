export type WatchlistSort = 'saved' | 'name' | 'change'
export type WatchlistTrend = 'up' | 'down' | 'sideways' | 'turn-up' | 'turn-down' | 'unavailable'

const collator = new Intl.Collator('ko-KR', { numeric: true })

export function rankWatchlist<T>(items: readonly T[], order: WatchlistSort,
  name: (item: T) => string, change: (item: T) => number | null | undefined): T[] {
  if (order === 'saved') return [...items]
  if (order === 'name') return [...items].sort((a, b) => collator.compare(name(a), name(b)))
  return [...items].sort((a, b) => (change(b) ?? -Infinity) - (change(a) ?? -Infinity))
}
