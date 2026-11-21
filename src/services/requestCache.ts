export function createRequestCache<T>(limit: number, ttlMs: number, clock = Date.now) {
  const entries = new Map<string, { value: T; expiresAt: number }>()
  const pending = new Map<string, Promise<T>>()

  function read(key: string) {
    const entry = entries.get(key)
    return entry && entry.expiresAt > clock() ? entry.value : undefined
  }

  function load(key: string, fetchValue: () => Promise<T>) {
    const cached = read(key)
    if (cached !== undefined) return Promise.resolve(cached)
    const existing = pending.get(key)
    if (existing) return existing
    const request = Promise.resolve().then(fetchValue).then(value => {
      entries.delete(key)
      entries.set(key, { value, expiresAt: clock() + ttlMs })
      if (entries.size > limit) entries.delete(entries.keys().next().value!)
      return value
    }).finally(() => pending.delete(key))
    pending.set(key, request)
    return request
  }

  return { read, load }
}
