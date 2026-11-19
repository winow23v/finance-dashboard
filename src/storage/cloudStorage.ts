import type { MarketSymbol } from '../types/marketSymbol'
import type { FavoriteRepository } from './favorites'

export interface AuthenticatedSession {
  readonly userId: string
}

// The future adapter must use the authenticated client and enforce ownership through RLS.
export class CloudFavoriteRepository implements FavoriteRepository<Promise<MarketSymbol[]>, Promise<boolean>> {
  constructor(readonly session: AuthenticatedSession) {
    if (!session?.userId.trim()) throw new Error('인증된 세션이 필요합니다.')
  }

  async load(): Promise<MarketSymbol[]> {
    throw new Error('클라우드 관심종목 저장소가 연결되지 않았습니다.')
  }

  async save(_items: readonly MarketSymbol[]): Promise<boolean> {
    throw new Error('클라우드 관심종목 저장소가 연결되지 않았습니다.')
  }
}

export interface CloudStorage {
  openFavorites(session: AuthenticatedSession): FavoriteRepository<Promise<MarketSymbol[]>, Promise<boolean>>
}

export const cloudStorage: CloudStorage = {
  openFavorites: session => new CloudFavoriteRepository(session),
}
