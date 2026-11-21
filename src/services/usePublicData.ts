import { useEffect, useState } from 'react'
import { FinanceApiError, getJson } from './apiFinanceService'

export function usePublicData<T>(path: string | undefined, revision: number, parse: (data: unknown) => T, timeoutMs?: number, retainData = false) {
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
    getJson(path, false, controller.signal, timeoutMs).then(parse).then(data => finish(data),
      error => finish(null, error instanceof FinanceApiError ? error.code : undefined))
    return () => controller.abort()
  }, [path, revision, parse, timeoutMs, retainData])
  return path !== undefined && result?.path === path &&
    (result.revision === revision || (retainData && result.data !== null)) ? result : undefined
}
