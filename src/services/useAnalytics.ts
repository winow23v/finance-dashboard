import { useEffect, useState } from 'react'
import { analyticsId, createAnalytics, readAnalyticsConsent, saveAnalyticsConsent } from './analytics'

const id = import.meta.env.PROD && import.meta.env.MODE === 'production' && import.meta.env.VITE_DATA_MODE === 'api'
  ? analyticsId(import.meta.env.VITE_GA4_ENABLED, import.meta.env.VITE_GA4_MEASUREMENT_ID) : undefined
let client: ReturnType<typeof createAnalytics> | undefined

function setEnabled(enabled: boolean) {
  if (!id) return
  const globals = window as unknown as Record<string, unknown>
  globals['ga-disable-' + id] = !enabled
  if (!enabled) {
    client?.reset()
    return
  }
  if (!client) {
    const queue: IArguments[] = []
    globals.dataLayer = queue
    function command() { queue.push(arguments) }
    client = createAnalytics({ measurementId: id, origin: location.origin, base: import.meta.env.BASE_URL, command })
    client.configure()
    const tag = document.createElement('script')
    tag.async = true
    tag.referrerPolicy = 'no-referrer'
    tag.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(id)
    document.head.append(tag)
  }
}

export function useAnalytics(page: string) {
  const [enabled, setConsent] = useState(() => Boolean(id && readAnalyticsConsent()))
  useEffect(() => {
    setEnabled(enabled)
    if (enabled) client?.page(page)
  }, [enabled, page])
  return { available: Boolean(id), enabled, setConsent(granted: boolean) {
    if (!id) return
    saveAnalyticsConsent(granted)
    if (!granted) setEnabled(false)
    setConsent(granted)
  } }
}
