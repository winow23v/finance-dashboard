// The snapshot endpoint uses a 30-second TTL. KRX overview reads the
// server-selected session on demand, so use the same short reuse window.
// Trading dates and scheduled collection remain authoritative on the server.
const reuseWindow = 30_000

export function canReuseMarketEntry(entry: { revision: number; checkedAt: number; failed: boolean } | undefined, revision: number, now: number) {
  if (!entry || entry.failed || entry.revision !== revision) return false
  const age = now - entry.checkedAt
  return age >= 0 && age < reuseWindow
}
