import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchMemberApi } from './memberTransport'

export const memberStatuses = ['pending', 'approved', 'rejected', 'suspended'] as const
export type MemberStatus = typeof memberStatuses[number]
export type MemberSession = { userId: string; email: string; status: MemberStatus; admin: boolean }
export type Member = { user_id: string; email: string; status: MemberStatus; created_at: string }
export type MemberPage = { members: Member[]; more: boolean }

const url = import.meta.env.VITE_SUPABASE_URL?.trim()
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim()
async function createAuthClient() {
  if (!url || !key?.startsWith('sb_publishable_')) return null
  try {
    const origin = new URL(url)
    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) return null
    const { createClient } = await import('@supabase/supabase-js')
    return createClient(origin.origin, key, { auth: { flowType: 'pkce' } })
  } catch {
    return null
  }
}
let authClient: Promise<SupabaseClient | null> | undefined
export function loadAuthClient() {
  authClient ??= createAuthClient()
  return authClient
}

export class MemberApiError extends Error {
  constructor(readonly status: number) { super('Membership request failed') }
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetchMemberApi(path, {
    ...options, signal: options?.signal ?? AbortSignal.timeout(12_000),
  }, path !== '/api/v1/session')
  if (!response.ok) throw new MemberApiError(response.status)
  return response.json() as Promise<T>
}

export const membershipApi = {
  session(signal?: AbortSignal) {
    return request<MemberSession>('/api/v1/session', {
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(12_000)]) : undefined,
    })
  },
  list(page: number, signal: AbortSignal, status?: MemberStatus, email?: string) {
    const timeout = AbortSignal.any([signal, AbortSignal.timeout(12_000)])
    if (email) return request<MemberPage>('/api/v1/admin/members/search', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      signal: timeout, body: JSON.stringify({ page, status, email }),
    })
    const params = new URLSearchParams({ page: String(page), ...(status && { status }) })
    return request<MemberPage>('/api/v1/admin/members?' + params, { signal: timeout })
  },
  update(member: Member, status: MemberStatus) {
    return request<Member>('/api/v1/admin/members/' + encodeURIComponent(member.user_id), {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status, expectedStatus: member.status }),
    })
  },
}
