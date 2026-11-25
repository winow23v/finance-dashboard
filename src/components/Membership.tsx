import type { SupabaseClient } from '@supabase/supabase-js'
import { useEffect, useState } from 'react'
import { UserRound, LogOut, ShieldCheck } from 'lucide-react'
import { App } from '../App'
import { dataMode } from '../services/financeService'
import { invalidateMemberData, setMemberSession } from '../services/memberTransport'
import { loadAuthClient, membershipApi, MemberApiError, type MemberSession } from '../services/membership'
import { providerStatuses } from '../services/providerStatus'
import { guestStorage } from '../storage/guestStorage'
import { informationPages, SiteInformation, type InformationPage } from './SiteInformation'

const statusMessage = {
  pending: '관리자 승인 대기 중입니다.',
  rejected: '가입 신청이 거절되었습니다.',
  suspended: '이 계정의 이용이 정지되었습니다.',
}

export function Membership() {
  return dataMode === 'api' ? <MemberGate /> : <App />
}

function MemberGate() {
  const [authClient, setAuthClient] = useState<SupabaseClient | null>()
  const [identity, setIdentity] = useState<string | null>()
  const [member, setMember] = useState<MemberSession>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [page, setPage] = useState(() => location.hash.slice(1))
  const [revision, retry] = useState(0)
  const activeMember = member?.userId === identity ? member : undefined

  useEffect(() => {
    const { theme, fontSize } = guestStorage.loadSettings()
    document.documentElement.dataset.theme = theme
    document.documentElement.dataset.fontSize = fontSize
    const onHash = () => setPage(location.hash.slice(1))
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  useEffect(() => {
    let active = true
    void loadAuthClient().then(client => { if (active) setAuthClient(client) })
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (!authClient) return
    if (new URLSearchParams(location.search).has('error')) setError('Google 로그인을 완료하지 못했습니다.')
    const { data: { subscription } } = authClient.auth.onAuthStateChange((event, session) => {
      if (session && (event === 'SIGNED_IN' || event === 'INITIAL_SESSION')) {
        try {
          const returnHash = sessionStorage.getItem('finance.oauth-return')
          sessionStorage.removeItem('finance.oauth-return')
          if (returnHash?.startsWith('#') && !location.hash) location.hash = returnHash
        } catch { /* The default dashboard route remains available. */ }
      }
      const id = session?.user.id
      setMemberSession(session?.access_token, id)
      setIdentity(id ?? null)
    })
    return () => subscription.unsubscribe()
  }, [authClient])

  useEffect(() => {
    setMember(undefined)
    providerStatuses.clear()
    if (!identity) return
    let controller: AbortController | undefined
    function check(invalidate = false) {
      if (invalidate) {
        invalidateMemberData()
        providerStatuses.clear()
        setMember(undefined)
        controller?.abort()
      } else if (controller) return
      const request = new AbortController()
      controller = request
      void membershipApi.session(request.signal).then(value => {
        if (request.signal.aborted) return
        if (value.userId !== identity) throw new Error('Session identity changed')
        if (value.status !== 'approved') {
          invalidateMemberData()
          providerStatuses.clear()
        }
        setMember(value)
        setError('')
      }).catch(error => {
        if (request.signal.aborted) return
        invalidateMemberData()
        providerStatuses.clear()
        setMember(undefined)
        setError(error instanceof MemberApiError && error.status === 401
          ? '로그인 세션을 확인할 수 없습니다. 다시 로그인해 주세요.'
          : '회원 상태를 확인할 수 없습니다. 잠시 후 다시 확인해 주세요.')
      }).finally(() => { if (controller === request) controller = undefined })
    }

    const accessChanged = () => check(true)
    const focus = () => check()
    const timer = window.setInterval(focus, 30_000)
    window.addEventListener('focus', focus)
    window.addEventListener('finance:membership-changed', accessChanged)
    check()
    return () => {
      controller?.abort()
      window.clearInterval(timer)
      window.removeEventListener('focus', focus)
      window.removeEventListener('finance:membership-changed', accessChanged)
    }
  }, [identity, revision])

  async function signIn() {
    if (!authClient) return
    setBusy(true)
    setError('')
    try {
      const target = new URL(import.meta.env.BASE_URL, location.origin)
      try { sessionStorage.setItem('finance.oauth-return', location.hash) } catch { /* Optional return route. */ }
      const { error } = await authClient.auth.signInWithOAuth({
        provider: 'google', options: { redirectTo: target.href },
      })
      if (error) throw error
    } catch {
      setError('Google 로그인을 시작할 수 없습니다.')
      setBusy(false)
    }
  }

  async function signOut() {
    if (!authClient) return
    setBusy(true)
    try {
      const { error } = await authClient.auth.signOut({ scope: 'local' })
      if (error) throw error
      setError('')
    } catch {
      setError('로그아웃하지 못했습니다. 다시 시도해 주세요.')
    } finally {
      setBusy(false)
    }
  }

  if (activeMember?.status === 'approved') {
    return <App key={activeMember.userId} member={activeMember} signOut={signOut} accountBusy={busy} accountError={error} />
  }

  const information = Object.hasOwn(informationPages, page) ? page as InformationPage : undefined
  return <main className="member-gate">
    <div className="member-brand"><img src={import.meta.env.BASE_URL + 'favicon.svg?v=19k'} alt="" width={30} height={30} /> Finance Dashboard</div>
    {information && <><h1>{informationPages[information]}</h1><SiteInformation page={information} /></>}
    <section className="panel member-panel">
      <h2><ShieldCheck size={20} aria-hidden="true" /> 회원 전용 대시보드</h2>
      {authClient === null ? <p role="status">Google 로그인 설정을 확인할 수 없습니다.</p>
        : (!authClient || identity === undefined && !error) ? <p role="status">로그인 상태 확인 중</p>
          : identity ? <>
            <p role="status">{activeMember ? statusMessage[activeMember.status] : '회원 상태 확인 중'}</p>
            <div className="member-actions">
              <button className="button" disabled={busy} onClick={() => retry(value => value + 1)}>승인 상태 다시 확인</button>
              <button className="button" disabled={busy} onClick={signOut}><LogOut size={16} /> 로그아웃</button>
            </div>
          </> : <>
            <p>Google 계정으로 로그인하면 관리자 승인 후 금융 데이터를 이용할 수 있습니다.</p>
            <button className="button" disabled={busy} onClick={signIn}><UserRound size={16} /> Google로 로그인</button>
          </>}
      {error && <p className="notice" role="alert">{error}</p>}
    </section>
    <nav className="footer-links" aria-label="서비스 정보">
      {Object.entries(informationPages).map(([id, label]) => <a key={id} href={'#' + id}>{label}</a>)}
    </nav>
  </main>
}
