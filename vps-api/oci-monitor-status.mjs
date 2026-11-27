import { createHash, timingSafeEqual } from 'node:crypto'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'

const path = '/api/v1/monitor/oci/status'
const maxBytes = 32 * 1024
const minute = 60_000
const timerNames = ['oci-arm-monitor.timer', 'oci-arm-retry.timer', 'oci-arm-notify.timer']
const states = ['WAITING_ELIGIBILITY', 'CAPACITY_WAIT', 'SUBMITTING', 'UNKNOWN_RESULT',
  'PROVISIONING', 'COMPLETED', 'BLOCKED']
const instanceStates = ['PROVISIONING', 'STARTING', 'RUNNING', 'STOPPING', 'STOPPED',
  'CREATING_IMAGE', 'MOVING', 'TERMINATING', 'TERMINATED']
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const blockReasons = ['ARM_QUOTA_UNAVAILABLE', 'ARM_SHAPE_UNAVAILABLE', 'FREE_ELIGIBILITY_UNVERIFIED',
  'AUTO_CREATE_DISABLED', 'CAPACITY_WAIT', 'UNKNOWN_RESULT', 'DUPLICATE_RISK', 'LIMIT_REACHED', 'SAFETY_GATE']
const nonnegative = value => Number.isFinite(value) && value >= 0 ? value : null
const count = value => Number.isSafeInteger(value) ? nonnegative(value) : null
const flag = value => typeof value === 'boolean' ? value : null
const from = (value, allowed) => allowed.includes(value) ? value : null

function timestamp(value) {
  if (typeof value !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null
  const millis = Date.parse(value)
  return Number.isFinite(millis) ? new Date(millis).toISOString() : null
}

function publicStatus(snapshot, now) {
  const { arm, provisioning, monitor, notification, host } = snapshot
  const checkedAt = timestamp(monitor?.last_success_at)
  const age = now - Date.parse(checkedAt)
  const region = typeof snapshot.region === 'string' && /^[a-z]{2}(?:-[a-z]+)+-\d+$/.test(snapshot.region)
    ? snapshot.region : null
  const status = from(provisioning?.status, states)
  const failed = flag(monitor?.last_check_failed)
  if (snapshot.schema_version !== 1 || !checkedAt || age < 0 || !region || !status ||
      ![arm, provisioning, monitor].every(isRecord) || failed === null ||
      flag(provisioning.created) === null || count(provisioning.attempts) === null ||
      flag(provisioning.auto_create_enabled) === null || flag(arm.free_eligibility_verified) === null ||
      !(arm.shape_available === null || typeof arm.shape_available === 'boolean') ||
      ![arm.available_ocpus, arm.available_memory_gb].every(value => value === null || nonnegative(value) !== null) ||
      !(nonnegative(arm.target_ocpus) > 0 && nonnegative(arm.target_memory_gb) > 0)) {
    throw new Error('Invalid snapshot')
  }
  const observedAt = timestamp(provisioning.instance_observed_at)
  const instanceState = from(provisioning.instance_lifecycle_state, instanceStates)
  const instanceObserved = instanceState && observedAt && Date.parse(observedAt) <= now
  const dataStatus = age > 180 * minute ? 'critical' : age > 75 * minute ? 'stale' : 'fresh'

  return {
    schema_version: 1,
    region,
    checked_at: checkedAt,
    data_status: dataStatus,
    arm: {
      availability_domain: from(arm.availability_domain, ['AD-1', 'AD-2', 'AD-3']),
      shape_available: flag(arm.shape_available),
      available_ocpus: nonnegative(arm.available_ocpus),
      available_memory_gb: nonnegative(arm.available_memory_gb),
      regional_available_ocpus: nonnegative(arm.regional_available_ocpus),
      regional_available_memory_gb: nonnegative(arm.regional_available_memory_gb),
      target_ocpus: nonnegative(arm.target_ocpus),
      target_memory_gb: nonnegative(arm.target_memory_gb),
      meets_target: flag(arm.meets_target),
      free_eligibility_verified: flag(arm.free_eligibility_verified),
      quota_is_current: dataStatus === 'fresh' && !failed &&
        arm.available_ocpus !== null && arm.available_memory_gb !== null,
    },
    provisioning: {
      status,
      created: flag(provisioning.created),
      attempts: count(provisioning.attempts),
      auto_create_enabled: flag(provisioning.auto_create_enabled),
      last_attempt_at: timestamp(provisioning.last_attempt_at),
      completed_at: timestamp(provisioning.completed_at),
      block_reason: from(provisioning.block_reason, blockReasons),
      instance_lifecycle_state: instanceObserved ? instanceState : null,
      instance_observed_at: instanceObserved ? observedAt : null,
    },
    monitor: {
      status: failed ? 'failed' : dataStatus === 'fresh' ? 'healthy' : 'delayed',
      last_check_failed: failed,
      interval_seconds: count(monitor.interval_seconds),
      last_success_at: checkedAt,
      next_run_at: timestamp(monitor.next_run_at),
      timers: Object.fromEntries(timerNames.map(name => [name, {
        state: from(monitor.timers?.[name]?.state, ['active', 'inactive', 'failed', 'activating', 'deactivating']),
        next_run_at: timestamp(monitor.timers?.[name]?.next_run_at),
      }])),
    },
    notification: {
      provider: 'ntfy',
      pending_count: count(notification?.pending_count),
      last_success_at: timestamp(notification?.last_success_at),
    },
    host: {
      sampled_at: timestamp(host?.sampled_at),
      cpu_usage_percent: nonnegative(host?.cpu_usage_percent),
      load_average: [0, 1, 2].map(index => nonnegative(host?.load_average?.[index])),
      memory_total_bytes: count(host?.memory_total_bytes),
      memory_available_bytes: count(host?.memory_available_bytes),
      swap_used_bytes: count(host?.swap_used_bytes),
      disk_used_percent: nonnegative(host?.disk_used_percent),
      uptime_seconds: nonnegative(host?.uptime_seconds),
    },
  }
}

async function readSnapshot(filename, ownerUid) {
  if (!Number.isSafeInteger(ownerUid) || ownerUid < 0) throw new Error('Invalid snapshot owner')
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const info = await file.stat()
    // An atomic replacement can unlink the old file while this descriptor still reads it.
    if (!info.isFile() || info.uid !== ownerUid || info.nlink > 1 || (info.mode & 0o7137) !== 0 ||
        info.size > maxBytes) throw new Error('Invalid snapshot file')
    const buffer = Buffer.alloc(maxBytes + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length)
      if (!bytesRead) break
      length += bytesRead
    }
    if (length > maxBytes) throw new Error('Invalid snapshot size')
    return JSON.parse(buffer.toString('utf8', 0, length))
  } finally {
    await file.close()
  }
}

const digest = value => createHash('sha256').update(value).digest()

export function registerOciMonitorStatus(app, { token, filename = '/var/lib/oci-arm-monitor/status.json', ownerUid }) {
  // A 32-byte random token is configured as 64 lowercase hexadecimal digits.
  const expected = /^[a-f0-9]{64}$/.test(token ?? '') ? digest(`Bearer ${token}`) : null
  if (!expected) return

  const limitAnonymous = app.createRateLimit({ max: 20, keyGenerator: request => request.ip })
  const limitClient = app.createRateLimit({ max: 10, keyGenerator: () => 'oci-monitor' })

  app.route({
    method: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE'],
    url: path,
    exposeHeadRoute: false,
    config: { ociMonitorStatus: true, rateLimit: false },
    onRequest: async (request, reply) => {
      const https = request.raw.socket.encrypted ||
        (request.raw.socket.remoteAddress === '127.0.0.1' && request.headers['x-forwarded-proto'] === 'https')
      const authorized = https && timingSafeEqual(digest(request.headers.authorization ?? ''), expected)
      const limit = await (authorized ? limitClient : limitAnonymous)(request)
      if (limit.isExceeded) return reply.header('retry-after', Math.max(1, Math.ceil(limit.ttl / 1000)))
        .code(429).send({ code: 'OCI_MONITOR_RATE_LIMITED' })
      if (!https) return reply.code(403).send({ code: 'HTTPS_REQUIRED' })
      if (request.method !== 'GET') return reply.header('allow', 'GET').code(405).send({ code: 'METHOD_NOT_ALLOWED' })
      if (!authorized) return reply.header('www-authenticate', 'Bearer').code(401).send({ code: 'AUTH_REQUIRED' })
      if (request.url.includes('?')) return reply.code(400).send({ code: 'QUERY_NOT_ALLOWED' })
    },
    handler: async (_request, reply) => {
      try {
        return publicStatus(await readSnapshot(filename, ownerUid), Date.now())
      } catch {
        return reply.code(503).send({ data_status: 'unavailable', code: 'OCI_MONITOR_STATUS_UNAVAILABLE' })
      }
    },
  })
}
