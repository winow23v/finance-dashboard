import { useEffect, useState } from 'react'
import { memberDataEpoch } from './memberTransport'
import { FinanceApiError, getJson } from './apiFinanceService'
import type { createRequestCache } from './requestCache'

export function usePublicData<T>(path: string | undefined, revision: number, parse: (data: unknown) => T, timeoutMs?: number, retainData = false,
  cache?: ReturnType<typeof createRequestCache<T>>) {
  const epoch = memberDataEpoch()
  const cacheKey = JSON.stringify([epoch, path, revision])
  const [result, setResult] = useState<{ path: string; revision: number; data: T | null; errorCode?: string; refreshFailed?: boolean }>()
  useEffect(() => {
    if (!path) return
    const controller = new AbortController()
    const finish = (data: T | null, errorCode?: string) => {
      if (!controller.signal.aborted) setResult(previous => {
        if (retainData && data === null && previous?.path === path && previous.data !== null) {
          return { ...previous, revision, refreshFailed: true }
        }
        return { path, revision, data, errorCode }
      })
    }
    const request = cache
      ? cache.load(cacheKey, () => getJson(path, false, undefined, timeoutMs).then(parse))
      : getJson(path, false, controller.signal, timeoutMs).then(parse)
    request.then(data => finish(data),
      error => finish(null, error instanceof FinanceApiError ? error.code : undefined))
    return () => controller.abort()
  }, [path, revision, parse, timeoutMs, retainData, cache, cacheKey])
  const cached = path && cache ? cache.read(cacheKey) : undefined
  if (path && cached !== undefined) return { path, revision, data: cached, errorCode: undefined, refreshFailed: false }
  return path !== undefined && result?.path === path &&
    (result.revision === revision || (retainData && result.data !== null)) ? result : undefined
}
