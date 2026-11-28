import type { SupabaseClient } from '@supabase/supabase-js'
import { useEffect, useRef, useState } from 'react'
import { BarChart3, Globe2, LockKeyhole, LogOut, X } from 'lucide-react'
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
  const information = Object.hasOwn(informationPages, page) ? page as InformationPage : undefined
  const informationDialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = informationDialog.current
    if (information && dialog && !dialog.open) dialog.showModal()
    if (!information) dialog?.close()
  }, [information])
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

  return <main className="member-gate">
    <div className="member-brand"><img src={import.meta.env.BASE_URL + 'favicon.svg?v=19k'} alt="" width={30} height={30} /> Finance Dashboard</div>
    <div className="member-layout">
      <section className="member-intro" aria-labelledby="member-preview-title">
        <h1 id="member-preview-title">국내외 시장을 한 화면에서</h1>
        <p>시장지수, 환율, 종목별 일봉을 확인하고 관심종목을 관리하세요.</p>
      </section>
      <section className="panel member-panel" aria-labelledby="member-access-title">
        <LockKeyhole className="member-access-icon" size={22} aria-hidden="true" />
        <h2 id="member-access-title">회원 전용 대시보드</h2>
        {authClient === null ? <p role="status">Google 로그인 설정을 확인할 수 없습니다.</p>
          : (!authClient || identity === undefined && !error) ? <p role="status">로그인 상태 확인 중</p>
            : identity ? <>
              {activeMember?.status === 'pending' && <>
                <span className="muted-badge member-approval-badge">승인 대기</span>
                <ol className="member-steps">
                  <li>Google 로그인 완료</li><li aria-current="step">관리자 승인 대기</li><li>대시보드 이용 시작</li>
                </ol>
              </>}
              <p role="status">{activeMember ? statusMessage[activeMember.status] : '회원 상태 확인 중'}</p>
              <div className="member-actions">
                <button className="button" disabled={busy} onClick={() => retry(value => value + 1)}>승인 상태 다시 확인</button>
                <button className="button" disabled={busy} onClick={signOut}><LogOut size={16} /> 로그아웃</button>
              </div>
            </> : <>
              <p>Google 계정으로 로그인하면 관리자 승인 후 금융 데이터를 이용할 수 있습니다.</p>
              <button className="button google-login" disabled={busy} onClick={signIn}><GoogleMark /> Google로 로그인</button>
            </>}
        {error && <p className="notice" role="alert">{error}</p>}
      </section>
      <section className="member-preview" aria-labelledby="member-markets-title">
        <div className="member-preview-heading">
          <h2 id="member-markets-title">대시보드 미리보기</h2>
          <span><LockKeyhole size={13} aria-hidden="true" /> 승인 후 확인</span>
        </div>
        <ul className="member-market-list">
          {[
            { label: 'KOSPI', description: '국내 시장지수', icon: BarChart3 },
            { label: 'S&P 500', description: '미국 시장지수', icon: BarChart3 },
            { label: 'USD/KRW', description: '원·달러 환율', icon: Globe2 },
          ].map(({ label, description, icon: Icon }) => <li key={label}>
            <Icon size={18} strokeWidth={1.7} aria-hidden="true" />
            <h3>{label}</h3>
            <small>{description}</small>
          </li>)}
        </ul>
      </section>
    </div>
    <dialog ref={informationDialog} className="panel member-information" aria-labelledby="member-information-title"
      onClick={event => { if (event.target === event.currentTarget) event.currentTarget.close() }}
      onClose={() => { if (Object.hasOwn(informationPages, location.hash.slice(1))) location.hash = 'overview' }}>
      {information && <div className="member-information-content">
        <div className="section-heading"><h2 id="member-information-title">{informationPages[information]}</h2>
          <button type="button" className="icon-button" aria-label="정보 닫기" onClick={() => informationDialog.current?.close()}><X size={18} /></button>
        </div>
        <SiteInformation page={information} />
      </div>}
    </dialog>
    <nav className="footer-links" aria-label="서비스 정보">
      {Object.entries(informationPages).map(([id, label]) => <a key={id} href={'#' + id}>{label}</a>)}
    </nav>
  </main>
}

function GoogleMark() {
  return <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
    <path fill="#4285F4" d="M43.61 24.46c0-1.36-.12-2.66-.34-3.92H24v7.43h11a9.4 9.4 0 0 1-4.08 6.17v5.14h6.62c3.87-3.56 6.07-8.8 6.07-14.82z"/>
    <path fill="#34A853" d="M24 44c5.51 0 10.13-1.83 13.51-4.72l-6.62-5.14c-1.83 1.22-4.17 1.95-6.89 1.95-5.33 0-9.85-3.6-11.47-8.44H5.7v5.3A20 20 0 0 0 24 44z"/>
    <path fill="#FBBC05" d="M12.53 27.65a12 12 0 0 1 0-7.3v-5.3H5.7a20.03 20.03 0 0 0 0 17.9z"/>
    <path fill="#EA4335" d="M24 11.91c3.02 0 5.71 1.04 7.84 3.08l5.87-5.87C34.1 5.76 29.51 4 24 4A20 20 0 0 0 5.7 15.05l6.83 5.3c1.62-4.84 6.14-8.44 11.47-8.44z"/>
  </svg>
}
