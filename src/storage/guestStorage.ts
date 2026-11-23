import type { MarketSymbol } from '../types/marketSymbol'
import { mergeFavorites, type FavoriteRepository } from './favorites'

export type SettingsState = {
  theme: 'dark' | 'light'
  market: 'overview' | 'domestic' | 'global'
  units: 'full' | 'compact'
  colors: 'green' | 'red'
}

type Stored<T> = { version: 1; data: T }

const settingsKey = 'finance.settings'
const favoritesKey = 'finance.watchlist'

// Version 0 stored bare IDs. Keep their original listing venues during migration.
const legacyListings: Record<string, MarketSymbol> = {
  '005930': { market: 'KR', exchange: 'XKRX', symbol: '005930' },
  '000660': { market: 'KR', exchange: 'XKRX', symbol: '000660' },
  '035420': { market: 'KR', exchange: 'XKRX', symbol: '035420' },
  AAPL: { market: 'US', exchange: 'XNAS', symbol: 'AAPL' },
  NVDA: { market: 'US', exchange: 'XNAS', symbol: 'NVDA' },
  MSFT: { market: 'US', exchange: 'XNAS', symbol: 'MSFT' },
}

function read(key: string): unknown {
  try {
    return JSON.parse(window.localStorage.getItem(key) ?? 'null')
  } catch {
    return null
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function write<T>(key: string, data: T): boolean {
  const current = record(read(key))
  if (current && 'version' in current && current.version !== 1) return false
  try {
    const payload: Stored<T> = { version: 1, data }
    window.localStorage.setItem(key, JSON.stringify(payload))
    return true
  } catch {
    return false
  }
}

export const guestPreferences = {
  load(key: string) {
    const payload = record(read(key))
    return payload?.version === 1 ? payload.data : undefined
  },
  save: write,
}

function isMarketSymbol(value: unknown): value is MarketSymbol {
  const item = record(value)
  return !!item && (item.market === 'KR' || item.market === 'US')
    && typeof item.exchange === 'string' && !!item.exchange.trim()
    && typeof item.symbol === 'string' && !!item.symbol.trim()
}

export class LocalFavoriteRepository implements FavoriteRepository<MarketSymbol[], boolean> {
  load(): MarketSymbol[] {
    const stored = read(favoritesKey)
    if (Array.isArray(stored)) {
      return mergeFavorites(stored.flatMap((id): MarketSymbol[] => {
        if (typeof id !== 'string') return []
        const symbol = id.trim().toUpperCase().replace('.', '-')
        if (Object.hasOwn(legacyListings, symbol)) return [legacyListings[symbol]]
        if (/^[0-9]{6}$/.test(symbol)) return [{ market: 'KR', exchange: 'XKRX', symbol }]
        if (/^[A-Z][A-Z0-9]{0,9}(-[A-Z0-9]{1,5})?$/.test(symbol)) return [{ market: 'US', exchange: 'US', symbol }]
        return []
      }))
    }
    const payload = record(stored)
    return payload?.version === 1 && Array.isArray(payload.data)
      ? mergeFavorites(payload.data.filter(isMarketSymbol))
      : []
  }

  save(items: readonly MarketSymbol[]): boolean {
    return write(favoritesKey, mergeFavorites(items))
  }
}

export interface GuestStorage {
  favorites: FavoriteRepository<MarketSymbol[], boolean>
  loadSettings(): SettingsState
  saveSettings(settings: SettingsState): boolean
}

export const guestStorage: GuestStorage = {
  favorites: new LocalFavoriteRepository(),
  loadSettings(): SettingsState {
    const payload = record(read(settingsKey))
    const stored = payload && 'version' in payload
      ? (payload.version === 1 ? record(payload.data) : undefined)
      : payload
    return {
      theme: stored?.theme === 'light' ? 'light' : 'dark',
      market: stored?.market === 'domestic' || stored?.market === 'global' ? stored.market : 'overview',
      units: stored?.units === 'compact' ? 'compact' : 'full',
      colors: stored?.colors === 'red' ? 'red' : 'green',
    }
  },
  saveSettings(settings: SettingsState): boolean {
    return write(settingsKey, settings)
  },
}
