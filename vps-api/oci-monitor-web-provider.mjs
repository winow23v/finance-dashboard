import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { loadOciMonitorStatus, isMonitorHttps } from './oci-monitor-status-provider.mjs'

const derive = promisify(scrypt)
const loginPath = '/monitor/login'
const statusPath = '/monitor/status'
const sessionName = '__Secure-oci-monitor-session'
const csrfName = '__Secure-oci-monitor-csrf'
const sessionSeconds = 24 * 60 * 60
const tokenPattern = /^[a-f0-9]{64}$/
const token = () => randomBytes(32).toString('hex')
const hash = value => createHash('sha256').update(value).digest()
const equals = (left, right) => timingSafeEqual(hash(left), hash(right))
const escape = value => String(value ?? '미확인').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char])
const kst = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'medium', timeStyle: 'medium' })
const labels = {
  fresh: '최신', stale: '갱신 지연', critical: '심각한 지연', unavailable: '조회 불가',
  WAITING_ELIGIBILITY: '무료 자격 확인 대기', CAPACITY_WAIT: '수용 공간 대기',
  SUBMITTING: '요청 제출 중', UNKNOWN_RESULT: '결과 미확인', PROVISIONING: '생성 중',
  COMPLETED: '생성 완료', BLOCKED: '생성 차단', FREE_ELIGIBILITY_UNVERIFIED: '무료 이용 자격 미검증 (자체 안전 정책)',
  ARM_QUOTA_UNAVAILABLE: 'Oracle 할당량 부족', ARM_SHAPE_UNAVAILABLE: 'Oracle Shape 미확인 또는 사용 불가',
  AUTO_CREATE_DISABLED: '자동 생성 꺼짐 (자체 정책)', DUPLICATE_RISK: '중복 생성 위험 (자체 정책)',
  LIMIT_REACHED: '생성 한도 도달 (자체 정책)', SAFETY_GATE: '자체 안전 정책',
  active: '활성', inactive: '비활성', failed: '실패', activating: '활성화 중', deactivating: '비활성화 중',
}
const human = value => value ? labels[value] ?? value : null
const yesNo = value => value == null ? null : value ? '예' : '아니요'
const unit = (value, suffix) => value == null ? null : `${value} ${suffix}`
const memory = bytes => bytes == null ? null : bytes >= 1024 ** 3
  ? `${(bytes / 1024 ** 3).toFixed(2)} GiB` : `${(bytes / 1024 ** 2).toFixed(1)} MiB`
const time = value => value == null ? escape(null)
  : `<time datetime="${escape(value)}">${escape(kst.format(new Date(value)))} KST</time>`
const style = `
:root{color-scheme:light;font-family:system-ui,-apple-system,sans-serif;color:#132c32;background:#edf2f2;line-height:1.5}
*{box-sizing:border-box}body{margin:0}main{width:min(100% - 32px,1100px);margin:0 auto;padding:32px 0 56px}
header{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:24px;border-bottom:1px solid #b8caca;padding-bottom:16px}
h1,h2,p{margin:0}h1{font-size:clamp(1.6rem,4vw,2.2rem);letter-spacing:-.04em}h2{font-size:1.1rem;margin-bottom:12px}
small{font-weight:650;color:#315b60}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,360px),1fr));gap:16px}
section,.signin{background:#fff;border:1px solid #c5d4d5;border-radius:12px;padding:18px;min-width:0}
.signin{max-width:440px;margin:clamp(16px,9vh,96px) auto}.signin h1{margin-bottom:18px}
label{display:block;font-weight:650;margin-top:14px}input,button{font:inherit;min-height:44px;border-radius:7px}
input{display:block;width:100%;margin-top:5px;border:1px solid #789596;padding:8px}
button{background:#075a52;color:white;border:1px solid transparent;padding:8px 16px;font-weight:700;cursor:pointer}
button:hover{background:#03463f}.signin button{width:100%;margin-top:18px}a:focus-visible,input:focus-visible,button:focus-visible{outline:3px solid #0a7679;outline-offset:3px}
table{width:100%;border-collapse:collapse;font-size:.94rem}th,td{border-bottom:1px solid #dbe4e4;padding:7px 0;text-align:left;vertical-align:top;overflow-wrap:anywhere}
th{width:48%;padding-right:9px;font-weight:600}tr:last-child th,tr:last-child td{border:0}
.notice{padding:10px 12px;background:#ffeccf;color:#663914;border-radius:7px;margin-bottom:16px}
`
const styleHash = createHash('sha256').update(style).digest('base64')

function page(title, content) {
  return `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)} · OCI ARM 모니터</title><style>${style}</style><main>${content}</main></html>`
}

function loginPage(csrf, error) {
  return page('로그인', `<section class="signin"><small>OCI ARM 모니터 · 읽기 전용</small><h1>모니터 로그인</h1>
${error ? `<p role="alert" class="notice">${escape(error)}</p>` : ''}
<form method="post" action="${loginPath}">
<input type="hidden" name="csrf" value="${escape(csrf)}">
<label for="username">계정 이름</label><input id="username" name="username" type="text" autocomplete="username" maxlength="64" required>
<label for="password">비밀번호</label><input id="password" name="password" type="password" autocomplete="current-password" maxlength="256" required>
<button type="submit">로그인</button></form></section>`)
}

const row = (name, value) => [name, escape(value)]
const at = (name, value) => [name, time(value)]
const schedule = (name, timer) => at(timer.next_run_source === 'monotonic_estimate'
  ? name + ' (시계 환산 예상)' : name, timer.next_run_at)
const table = (title, rows) => `<section><h2>${escape(title)}</h2><table><tbody>${rows.map(([name, value]) =>
  `<tr><th scope="row">${escape(name)}</th><td>${value}</td></tr>`).join('')}</tbody></table></section>`

function statusPage(data, csrf) {
  const header = `<header><div><small>읽기 전용</small><h1>OCI ARM 모니터</h1></div>
<form method="post" action="/monitor/logout"><input name="csrf" type="hidden" value="${escape(csrf)}">
<button type="submit">로그아웃</button></form></header>`
  if (!data) return page('상태 조회', header + '<p role="status" class="notice">조회 불가 (unavailable) · 스냅샷이 없거나 유효하지 않습니다.</p>')
  const { arm, provisioning: p, monitor: m, host: h, notification: n } = data
  const quotaLabel = arm.quota_is_current ? '' : ' (마지막 저장값)'
  const formatTarget = [unit(arm.target_ocpus, 'OCPU'), unit(arm.target_memory_gb, 'GiB')].join(' / ')
  const warning = m.last_check_failed ? ' · 최근 OCI 조회 실패' : ''
  return page('상태 조회', header + `<p role="status" class="notice">데이터 ${escape(human(data.data_status))} (${escape(data.data_status)})${warning}</p><div class="grid">` +
    table('Oracle ARM', [row('리전 / 가용 영역', `${data.region} / ${arm.availability_domain ?? '미확인'}`),
      row('AD CPU' + quotaLabel, unit(arm.ad_available_ocpus, 'OCPU')), row('AD RAM' + quotaLabel, unit(arm.ad_available_memory_gb, 'GiB')),
      row('리전 CPU' + quotaLabel, unit(arm.regional_available_ocpus, 'OCPU')), row('리전 RAM' + quotaLabel, unit(arm.regional_available_memory_gb, 'GiB')),
      row('목표 사양', formatTarget), row('ARM Shape 가용', yesNo(arm.shape_available)),
      row('실제 물리 서버 수용 공간', human(arm.capacity_observation)),
      row('생성 상태', human(p.status)), row('생성 시도', unit(p.attempts, '회')), row('생성 완료', yesNo(p.created)),
      row('인스턴스 마지막 관측', p.instance_lifecycle_state), at('관측 시각', p.instance_observed_at)]) +
    table('무료 생성 안전 정책', [row('무료 이용 자격 검증', yesNo(arm.free_eligibility_verified)),
      row('자동 생성 활성화', yesNo(p.auto_create_enabled)), row('유료 생성 허용', yesNo(p.paid_creation_allowed)),
      row('생성 차단 사유', human(p.block_reason)),
      row('Oracle 제한 / 자체 정책', '할당량·Shape와 무료 자격·자동 생성 승인을 별도로 판단합니다.')]) +
    table('기존 VPS', [row('CPU 사용률', unit(h.cpu_usage_percent, '%')),
      row('Load Average (1 / 5 / 15분)', h.load_average.map(x => x ?? '미확인').join(' / ')),
      row('전체 RAM', memory(h.memory_total_bytes)), row('가용 RAM', memory(h.memory_available_bytes)),
      row('Swap 사용', memory(h.swap_used_bytes)), row('디스크 사용률', unit(h.disk_used_percent, '%')),
      row('가동 시간', unit(h.uptime_seconds, '초')), at('자원 수집 시각', h.sampled_at)]) +
    table('감시 및 알림', [at('마지막 OCI 정상 조회', m.last_success_at),
      row('최근 OCI 조회 실패', yesNo(m.last_check_failed)), schedule('다음 감시 예정', m),
      row('감시 주기', unit(m.interval_seconds, '초')),
      ...Object.entries(m.timers).flatMap(([name, timer]) => [row(name, human(timer.state)), schedule('다음 예약 시각', timer)]),
      row('ntfy 대기', unit(n.pending_count, '건')), at('ntfy 마지막 전송 성공', n.last_success_at)]) + '</div>')
}

function cookie(request, name) {
  const matches = (request.headers.cookie ?? '').split(';').map(item => item.trim())
    .filter(item => item.startsWith(name + '='))
  const value = matches.length === 1 ? matches[0].slice(name.length + 1) : ''
  return tokenPattern.test(value) ? value : ''
}

function setCookie(reply, name, value, maxAge) {
  reply.header('set-cookie', `${name}=${value}; Path=/monitor; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`)
}

export async function registerOciMonitorWeb(app, {
  username, passwordHash, filename, ownerUid, origin = 'https://winow.duckdns.org',
  now = Date.now, sessionTtl = sessionSeconds,
}) {
  const parsed = /^([a-f0-9]{32}):([a-f0-9]{64})$/.exec(passwordHash ?? '')
  if (!parsed || !/^[A-Za-z0-9_-]{1,64}$/.test(username ?? '')) return
  const salt = Buffer.from(parsed[1], 'hex')
  const expected = Buffer.from(parsed[2], 'hex')
  const sessions = new Map()
  let verifying = false
  const failuresByIp = app.createRateLimit({ cache: 1000, max: 5, timeWindow: 300_000, keyGenerator: req => req.ip })
  const attemptsTotal = app.createRateLimit({ max: 30, timeWindow: 300_000, keyGenerator: () => 'monitor-login-global' })
  const config = { ociMonitorStatus: true }
  const loginSettings = { config, bodyLimit: 2048 }
  const session = request => {
    const id = cookie(request, sessionName)
    const entry = sessions.get(id)
    if (entry && entry.expires > now()) return entry
    sessions.delete(id)
  }
  const login = (request, reply, code = 200, error) => {
    let csrf = cookie(request, csrfName)
    if (!csrf) {
      csrf = token()
      setCookie(reply, csrfName, csrf, 900)
    }
    return reply.code(code).send(loginPage(csrf, error))
  }
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' },
    (_request, body, done) => done(null, new URLSearchParams(body)))
  app.addHook('onRequest', async (request, reply) => {
    reply.type('text/html; charset=utf-8')
      .header('content-security-policy', `default-src 'none'; style-src 'sha256-${styleHash}'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`)
      .header('referrer-policy', 'no-referrer').header('x-frame-options', 'DENY')
    if (!isMonitorHttps(request)) return reply.code(403).send(page('접근 제한', '<p>HTTPS가 필요합니다.</p>'))
    if (request.method === 'POST' && request.headers.origin !== origin) {
      return reply.code(403).send(page('접근 제한', '<p>요청 출처를 확인할 수 없습니다.</p>'))
    }
  })
  app.get(loginPath, { config }, (request, reply) => login(request, reply))
  app.post(loginPath, loginSettings, async (request, reply) => {
    const { body } = request
    const challenge = cookie(request, csrfName)
    const user = body instanceof URLSearchParams && body.get('username')
    const password = body instanceof URLSearchParams && body.get('password')
    const csrf = body instanceof URLSearchParams && body.get('csrf')
    if (!challenge || !tokenPattern.test(csrf ?? '') || !equals(challenge, csrf)) {
      return reply.code(403).send(page('접근 제한', '<p>로그인 페이지를 다시 열어 주세요.</p>'))
    }
    const global = await attemptsTotal(request)
    const ip = await failuresByIp(request)
    if (global.isExceeded || ip.isExceeded || verifying) {
      const ttl = Math.max(global.isExceeded ? global.ttl : 0, ip.isExceeded ? ip.ttl : 0)
      reply.header('retry-after', Math.max(1, Math.ceil(ttl / 1000)))
      return login(request, reply, 429, '잠시 뒤 다시 로그인해 주세요.')
    }
    if (!user || user.length > 64 || !password || Buffer.byteLength(password) > 256) {
      return login(request, reply, 401, '계정 이름 또는 비밀번호를 확인해 주세요.')
    }
    verifying = true
    let valid
    try {
      const derived = await derive(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 48 * 1024 * 1024 })
      valid = timingSafeEqual(derived, expected) && equals(username, user)
    } finally {
      verifying = false
    }
    if (!valid) return login(request, reply, 401, '계정 이름 또는 비밀번호를 확인해 주세요.')
    for (const [id, entry] of sessions) if (entry.expires <= now()) sessions.delete(id)
    sessions.delete(cookie(request, sessionName))
    if (sessions.size >= 128) sessions.delete(sessions.keys().next().value)
    const id = token()
    sessions.set(id, { csrf: token(), expires: now() + sessionTtl * 1000 })
    setCookie(reply, csrfName, '', 0)
    setCookie(reply, sessionName, id, sessionTtl)
    return reply.code(303).redirect(statusPath)
  })
  app.get(statusPath, { config }, async (request, reply) => {
    const entry = session(request)
    if (!entry) return reply.code(303).redirect(loginPath)
    const data = await loadOciMonitorStatus({ filename, ownerUid }).catch(() => null)
    return reply.code(data ? 200 : 503).send(statusPage(data, entry.csrf))
  })
  app.post('/monitor/logout', loginSettings, (request, reply) => {
    const entry = session(request)
    if (!entry) return reply.code(303).redirect(loginPath)
    const csrf = request.body instanceof URLSearchParams && request.body.get('csrf')
    if (!tokenPattern.test(csrf ?? '') || !equals(csrf, entry.csrf)) {
      return reply.code(403).send(page('접근 제한', '<p>로그아웃 요청을 확인할 수 없습니다.</p>'))
    }
    sessions.delete(cookie(request, sessionName))
    setCookie(reply, sessionName, '', 0)
    return reply.code(303).redirect(loginPath)
  })
}
