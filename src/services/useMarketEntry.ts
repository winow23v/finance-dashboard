import { useEffect, useRef, useState } from 'react'
import { marketRequestMessage } from './apiFinanceService'
import { canReuseMarketEntry } from './marketEntryPolicy'

export type MarketCheck = 'checking' | 'confirmed' | 'partial' | 'failed' | 'retained'

type Entry<T> = {
  revision: number
  checkedAt: number
  data: T | null
  valid: T | null
  failed: boolean
  check: Exclude<MarketCheck, 'checking'>
  message?: string
}

export function useMarketEntry<T>(
  page: string | undefined,
  revision: number,
  load: (signal: AbortSignal) => Promise<T>,
  assess: (value: T) => { usable: boolean; failed: boolean; partial?: boolean; previous?: boolean; reason?: string },
  failureText: string,
  key: string,
  onResult: (key: string, failed: boolean) => void,
) {
  const lastEntry = useRef<Entry<T>>(undefined)
  const [entry, setEntry] = useState<Entry<T>>()
  const [loading, setLoading] = useState(false)
  const inFlight = useRef<AbortController>(undefined)
  const active = !!page

  useEffect(() => () => {
    inFlight.current?.abort()
    inFlight.current = undefined
  }, [active, revision])

  useEffect(() => {
    if (!page || inFlight.current) return
    if (canReuseMarketEntry(lastEntry.current, revision, Date.now())) {
      setLoading(false)
      return
    }
    const controller = new AbortController()
    inFlight.current = controller
    setLoading(true)
    function finish(value: T | null, failed: boolean, failure?: string, unusable?: T, partial = false, previous = false) {
      if (controller.signal.aborted) return
      inFlight.current = undefined
      const valid = value ?? (failed ? lastEntry.current?.valid ?? null : null)
      const data = valid ?? unusable ?? null
      const retained = !!valid && (value === null || previous)
      const check = !failed ? 'confirmed' : retained ? 'retained' : partial ? 'partial' : 'failed'
      const message = failed
        ? (failure ?? failureText) + (retained ? ' · 이전 조회값 표시' : valid ? ' · 유효한 조회값 표시' : '')
        : undefined
      const next: Entry<T> = { revision, checkedAt: Date.now(), data, valid, failed, check, message }
      lastEntry.current = next
      setEntry(next)
      setLoading(false)
      onResult(key, failed)
    }
    void load(controller.signal).then(value => {
      const { usable, failed, partial, previous, reason } = assess(value)
      finish(usable ? value : null, failed, reason, value, partial, previous)
    }, error => finish(null, true, marketRequestMessage(error, failureText)))
  }, [page, revision, load, assess, failureText, key, onResult])

  const checking = !!page && (loading || !entry)
  return { entry, loading: checking, check: checking ? 'checking' as const : entry?.check }
}
