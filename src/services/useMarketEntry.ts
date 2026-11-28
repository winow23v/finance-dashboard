import { useEffect, useRef, useState } from 'react'
import { marketRequestMessage } from './apiFinanceService'
import { canReuseMarketEntry } from './marketEntryPolicy'

type Entry<T> = {
  revision: number
  checkedAt: number
  data: T | null
  valid: T | null
  failed: boolean
  message?: string
}

export function useMarketEntry<T>(
  page: string | undefined,
  revision: number,
  load: (signal: AbortSignal) => Promise<T>,
  assess: (value: T) => { usable: boolean; failed: boolean },
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
    function finish(value: T | null, failed: boolean, failure?: string, unusable?: T) {
      if (controller.signal.aborted) return
      inFlight.current = undefined
      const valid = value ?? (failed ? lastEntry.current?.valid ?? null : null)
      const data = valid ?? unusable ?? null
      const message = failed
        ? (failure ?? failureText) + (valid ? value === null ? ' · 이전 조회값 표시' : ' · 유효한 조회값 표시' : '')
        : undefined
      const next = { revision, checkedAt: Date.now(), data, valid, failed, message }
      lastEntry.current = next
      setEntry(next)
      setLoading(false)
      onResult(key, failed)
    }
    void load(controller.signal).then(value => {
      const { usable, failed } = assess(value)
      finish(usable ? value : null, failed, undefined, value)
    }, error => finish(null, true, marketRequestMessage(error, failureText)))
  }, [page, revision, load, assess, failureText, key, onResult])

  return { entry, loading: !!page && (loading || !entry) }
}
