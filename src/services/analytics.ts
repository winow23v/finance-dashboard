const measurementIdPattern = /^G-[A-Z0-9]{4,20}$/
const settingsKey = 'finance.analytics-consent.v1'

export function analyticsId(enabled: unknown, measurementId: unknown) {
  return enabled === '1' && typeof measurementId === 'string' && measurementIdPattern.test(measurementId) ? measurementId : undefined
}

export function analyticsPage(page: string) {
  if (page.startsWith('stock/')) return 'stock-detail'
  if (page.startsWith('index/')) return 'index-detail'
  switch (page) {
    case 'overview': case 'domestic': case 'global': case 'companies': case 'economy':
    case 'watchlist': case 'settings': case 'privacy': case 'sources': return page
    default: return 'other'
  }
}

type Command = (...args: unknown[]) => void

export function createAnalytics({
  measurementId, origin, base, command,
}: { measurementId: string; origin: string; base: string; command: Command }) {
  let lastPage: string | undefined
  const locationFor = (page: string) => new URL(base + 'analytics/' + analyticsPage(page), origin).href
  return {
    configure() {
      command('js', new Date())
      command('set', { page_location: locationFor('other'), page_referrer: '', page_title: 'Finance Dashboard' })
      command('consent', 'default', { analytics_storage: 'granted', ad_storage: 'denied',
        ad_user_data: 'denied', ad_personalization: 'denied' })
      command('config', measurementId, { send_page_view: false, allow_google_signals: false,
        allow_ad_personalization_signals: false, page_location: locationFor('other'), page_referrer: '' })
    },
    page(page: string) {
      if (page === lastPage) return
      lastPage = page
      const kind = analyticsPage(page)
      const parameters = { page_location: locationFor(page), page_title: kind, page_referrer: '' }
      command('set', parameters)
      command('event', 'page_view', parameters)
      if (kind === 'domestic' || kind === 'global') {
        command('event', 'market_view', { ...parameters, market: kind === 'domestic' ? 'KR' : 'US' })
      } else if (kind === 'stock-detail') command('event', 'stock_detail_view', parameters)
    },
    reset() { lastPage = undefined },
  }
}

export function readAnalyticsConsent() {
  try { return localStorage.getItem(settingsKey) === 'granted' } catch { return false }
}

export function saveAnalyticsConsent(granted: boolean) {
  try {
    if (granted) localStorage.setItem(settingsKey, 'granted')
    else localStorage.removeItem(settingsKey)
  } catch { /* Keep the choice in memory when storage is unavailable. */ }
}
