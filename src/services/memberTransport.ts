let token: string | undefined
let identity: string | undefined
let epoch = 0

export function setMemberSession(accessToken?: string, userId?: string) {
  if (identity !== userId) epoch++
  identity = userId
  token = accessToken
}

export function invalidateMemberData() { epoch++ }
export function memberDataEpoch() { return epoch }

export function requestUrl(path: string): string {
  const configured = import.meta.env.VITE_API_BASE_URL?.trim()
  if (import.meta.env.DEV && !configured) return path
  if (!configured) throw new Error('VITE_API_BASE_URL is required in production API mode')

  const base = new URL(configured)
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) {
    throw new Error('VITE_API_BASE_URL must be an HTTPS base URL')
  }
  return base.href.replace(/\/+$/, '') + path
}

export async function fetchMemberApi(path: string, options: RequestInit = {}, checkAccess = true) {
  const currentToken = token
  const currentEpoch = epoch
  const headers = new Headers(options.headers)
  headers.set('Accept', 'application/json')
  if (currentToken) headers.set('Authorization', 'Bearer ' + currentToken)
  const response = await fetch(requestUrl(path), {
    ...options, headers, redirect: 'error', cache: 'no-store', credentials: 'omit',
  })
  if (checkAccess && currentToken && epoch === currentEpoch && [401, 403].includes(response.status)) {
    const body: unknown = await response.clone().json().catch(() => null)
    if (response.status === 401 || (body && typeof body === 'object' && 'code' in body && body.code === 'MEMBER_NOT_APPROVED')) {
      window.dispatchEvent(new Event('finance:membership-changed'))
    }
  }
  if (epoch !== currentEpoch) {
    throw new DOMException('Membership changed', 'AbortError')
  }
  return response
}
