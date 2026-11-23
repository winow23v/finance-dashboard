import { useEffect, useRef, useState } from 'react'
import { favoriteKey, isWatchlistSymbol } from '../services/watchlist'
import type { MarketSymbol } from '../types/marketSymbol'
import { cloudFavorites } from './cloudStorage'
import { mergeFavorites } from './favorites'
import { guestPreferences, guestStorage } from './guestStorage'

type Operation = { type: 'load' } | { type: 'add' | 'import'; items: MarketSymbol[] }
  | { type: 'remove'; item: MarketSymbol }
type Status = 'loading' | 'ready' | 'saving' | 'saved' | 'error'
const importedKey = 'finance.watchlist-imported'
const empty: MarketSymbol[] = []

function readKeys(key: string): string[] {
  const value = guestPreferences.load(key)
  return Array.isArray(value) ? value.filter(item => typeof item === 'string') : []
}

export function useWatchlist(userId?: string) {
  const [local] = useState(() => guestStorage.favorites.load())
  const [guest, setGuest] = useState(local)
  const [localError, setLocalError] = useState(false)
  const [remote, setRemote] = useState<MarketSymbol[]>()
  const [status, setStatus] = useState<Status>('loading')
  const [failure, setFailure] = useState<Operation>()
  const marker = 'finance.watchlist-reviewed.' + userId
  const [reviewed, setReviewed] = useState(() => userId ? readKeys(marker) : [])
  const [imported, setImported] = useState(() => userId ? readKeys(importedKey) : [])
  const active = useRef<AbortController | null>(null)

  function remember(items: MarketSymbol[], adopted = false) {
    if (!items.length) return
    const key = adopted ? importedKey : marker
    const prior = adopted ? imported : reviewed
    const keys = [...new Set([...readKeys(key), ...prior, ...items.map(favoriteKey)])]
    if (adopted) setImported(keys)
    else setReviewed(keys)
    setLocalError(!guestPreferences.save(key, keys))
  }

  async function run(operation: Operation) {
    if (!userId || active.current) return
    const controller = new AbortController()
    const signal = controller.signal
    active.current = controller
    setFailure(undefined)
    setStatus(operation.type === 'load' ? 'loading' : 'saving')
    let remaining = operation.type === 'import' ? operation.items : []
    let reading = operation.type === 'load'
    const confirmed: MarketSymbol[] = []
    try {
      if (operation.type === 'load') {
        const items = await cloudFavorites.load(userId, signal)
        if (signal.aborted) return
        setRemote(items)
        remember(items.filter(item => local.some(entry => favoriteKey(entry) === favoriteKey(item))))
      } else if (operation.type === 'remove') {
        await cloudFavorites.remove(userId, operation.item, signal)
        if (signal.aborted) return
        setRemote(previous => previous?.filter(item => favoriteKey(item) !== favoriteKey(operation.item)))
      } else if (operation.type === 'add') {
        await cloudFavorites.add(userId, operation.items, signal)
        if (signal.aborted) return
        confirmed.push(...operation.items.filter(item => local.some(entry => favoriteKey(entry) === favoriteKey(item))))
      } else {
        while (remaining.length && !signal.aborted) {
          const batch = remaining.slice(0, 100)
          await cloudFavorites.add(userId, batch, signal)
          if (signal.aborted) return
          remaining = remaining.slice(batch.length)
          confirmed.push(...batch)
        }
      }
      if (operation.type !== 'load' && !signal.aborted) {
        reading = true
        const items = await cloudFavorites.load(userId, signal)
        if (signal.aborted) return
        setRemote(items)
      }
      if (!signal.aborted) setStatus(operation.type === 'load' ? 'ready' : 'saved')
    } catch {
      if (!signal.aborted) {
        setFailure(reading ? { type: 'load' } : operation.type === 'import' ? { type: 'import', items: remaining } : operation)
        setStatus('error')
      }
    } finally {
      if (!signal.aborted && confirmed.length) remember(confirmed, true)
      if (active.current === controller) active.current = null
    }
  }

  useEffect(() => {
    void run({ type: 'load' })
    return () => {
      active.current?.abort()
      active.current = null
    }
    // App is keyed by member ID. Load once for each mounted account.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId])

  const selected = userId ? remote ?? empty : guest
  const saved = new Set(selected.map(favoriteKey))
  const missing = remote ? [...new Map(local.filter(item => !saved.has(favoriteKey(item)) && !reviewed.includes(favoriteKey(item)) && !imported.includes(favoriteKey(item)))
    .map(item => [favoriteKey(item), item])).values()] : []
  const importable = missing.filter(isWatchlistSymbol)
  const blocked = !!userId && (!remote || status === 'saving' || status === 'loading' || !!failure)

  function toggle(item: MarketSymbol) {
    const existing = selected.find(entry => favoriteKey(entry) === favoriteKey(item))
    if (!userId) {
      setGuest(previous => existing ? previous.filter(entry => favoriteKey(entry) !== favoriteKey(item))
        : mergeFavorites(previous, [item]))
      return
    }
    if (blocked || !isWatchlistSymbol(item)) return
    void run(existing ? { type: 'remove', item: existing } : { type: 'add', items: [item] })
  }

  useEffect(() => {
    if (!userId && guest !== local) setLocalError(!guestStorage.favorites.save(guest))
  }, [guest, local, userId])

  return {
    selected, toggle, localError, blocked,
    sync: userId ? {
      status, failure: failure?.type, importable, unsupported: missing.length - importable.length,
      retry: () => { if (failure) void run(failure) },
      reload: () => { void run({ type: 'load' }) },
      importLocal: () => { if (!blocked && importable.length) void run({ type: 'import', items: importable }) },
      dismiss: () => { if (!blocked) remember(importable) },
    } : undefined,
  }
}

export type WatchlistSync = ReturnType<typeof useWatchlist>['sync']
