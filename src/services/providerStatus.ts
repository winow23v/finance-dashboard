type ProviderStatus = 'published' | 'previous' | 'restricted' | 'error' | 'unavailable' | 'partial'
const routes = {
  '/api/v1/economy/korea': 'ecos',
  '/api/v1/fx/latest': 'fx',
  '/api/v1/disclosures/kr': 'dart',
  '/api/v1/disclosures/us': 'sec',
} as const
type Provider = typeof routes[keyof typeof routes]
let current: Partial<Record<Provider, ProviderStatus>> = {}
const listeners = new Set<() => void>()

export function recordProviderStatus(path: string, status: ProviderStatus) {
  const route = path.split('?')[0]
  if (!Object.hasOwn(routes, route)) return
  const provider = routes[route as keyof typeof routes]
  if (current[provider] === status) return
  current = { ...current, [provider]: status }
  for (const listener of listeners) listener()
}

export const providerStatuses = {
  read: () => current,
  subscribe(listener: () => void) {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  },
}
