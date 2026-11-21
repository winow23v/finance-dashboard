import { useEffect, useState } from 'react'
import { membershipApi, MemberApiError, type Member, type MemberPage, type MemberStatus } from '../services/membership'

const labels = { pending: '대기', approved: '승인', rejected: '거절', suspended: '정지' }
const actions = ['approved', 'rejected', 'suspended'] as const

function actionLabel(current: MemberStatus, next: MemberStatus) {
  if (next === 'pending') return '승인 취소'
  if (current === 'suspended' && next === 'approved') return '정지 복구'
  return labels[next]
}

export function MemberAdmin({ userId }: { userId: string }) {
  const [email, setEmail] = useState('')
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<MemberStatus | ''>('pending')
  const [page, setPage] = useState(1)
  const [revision, reload] = useState(0)
  const [data, setData] = useState<MemberPage>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    setData(undefined)
    void membershipApi.list(page, controller.signal, status || undefined, search || undefined).then(result => {
      if (!controller.signal.aborted) setData(result)
    }, () => {
      if (!controller.signal.aborted) setError('회원 목록을 불러오지 못했습니다.')
    })
    return () => controller.abort()
  }, [page, revision, status, search])

  async function update(member: Member, next: MemberStatus) {
    const label = actionLabel(member.status, next)
    if (busy || !window.confirm(member.email + ' 계정을 ' + label + ' 처리할까요?')) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await membershipApi.update(member, next)
      setNotice(label + ' 처리를 완료했습니다.')
      reload(value => value + 1)
    } catch (error) {
      setError(error instanceof MemberApiError && error.status === 409
        ? '회원 상태가 변경되었습니다. 최신 목록을 확인해 주세요.' : '회원 상태를 변경하지 못했습니다.')
      reload(value => value + 1)
    } finally {
      setBusy(false)
    }
  }

  return <section className="panel member-panel" aria-label="회원 승인 관리">
    <div className="section-heading"><h2>회원 목록</h2>
      <button className="button" disabled={busy} onClick={() => { setError(''); reload(value => value + 1) }}>목록 새로고침</button>
    </div>
    <form className="disclosure-controls" onSubmit={event => {
      event.preventDefault()
      setError('')
      setPage(1)
      setSearch(email.trim())
      reload(value => value + 1)
    }}>
      <label>회원 이메일 <input type="email" maxLength={254} value={email}
        onChange={event => setEmail(event.target.value)} /></label>
      <button className="button" type="submit" disabled={busy}>검색</button>
      <label>상태 <select value={status} disabled={busy} onChange={event => {
        setError('')
        setPage(1)
        setStatus(event.target.value as MemberStatus | '')
      }}>
        <option value="">전체</option>
        {Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></label>
    </form>
    {notice && <p className="notice" role="status">{notice}</p>}
    {error && <p className="notice" role="alert">{error}</p>}
    {!data && !error && <p role="status">회원 목록 조회 중</p>}
    {data?.members.length === 0 && <p className="state">이 페이지에 회원이 없습니다.</p>}
    {data && <ul className="member-list">
      {data.members.map(member => <li key={member.user_id}>
        <div><strong>{member.email}</strong><small>{labels[member.status]}</small></div>
        <div className="member-actions">
          {member.user_id === userId ? <small>관리자 계정</small> : [...actions, ...(member.status === 'approved' ? ['pending' as const] : [])].map(next => {
            const label = actionLabel(member.status, next)
            return <button key={next} className="button" disabled={busy || member.status === next}
              aria-label={member.email + ' ' + label} onClick={() => { void update(member, next) }}>{label}</button>
          })}
        </div>
      </li>)}
    </ul>}
    <nav className="list-pagination" aria-label="회원 목록 페이지">
      <button className="button" disabled={busy || page === 1} onClick={() => setPage(value => value - 1)}>이전</button>
      <span>{page} 페이지</span>
      <button className="button" disabled={busy || !data?.more} onClick={() => setPage(value => value + 1)}>다음</button>
    </nav>
  </section>
}
