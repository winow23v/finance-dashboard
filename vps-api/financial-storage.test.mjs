import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { test } from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { createFinancialStorage } from './financial-storage-provider.mjs'

const day = '2026-11-28'
const clock = () => Date.parse(day + 'T05:00:00Z')
const corpCode = '99900001'
const issue = { symbol: '005930', market: 'KOSPI', isin: 'KR7005930003', shareClass: '보통주', asOf: day }
const issuer = { corpCode, name: 'isolated fixture' }
const account = (id, value, previous = null) => ({
  id, original: { accountId: 'fixture_' + id, name: id }, quality: 'reported', basis: 'annual', currency: 'KRW',
  unit: 'currency-unit', statement: 'CF', current: { status: 'reported', value },
  previous: previous === null ? { status: 'missing', value: null, reason: 'not-provided' } : { status: 'reported', value: previous },
})
const financials = () => ({
  mapping: { issue, issuer, issueAsOf: day, status: 'exact-code', sector: 'non-financial' },
  years: [{
    year: '2025', issuerCorpCode: corpCode, period: 'annual', scope: 'CFS', reportCode: '11011', status: 'available',
    sourceVersion: 1, source: 'isolated-fixture', collectedAt: day + 'T00:00:00Z', fiscalEnd: '2025-12-31',
    receipt: { id: '20260328000001', filedAt: '2026-03-28', amendment: 'as-filed' },
    accounts: [account('operatingCashFlow', '12345678901234567890.12345'), account('propertyPlantEquipmentAcquisitions', '-3', '0'),
      account('intangibleAcquisitions', '2')],
  }],
})
const market = { currency: 'KRW', coverage: { status: 'unverified' }, issues: [] }

async function fixtureDatabase(t) {
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role bypassrls;
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.jwt() returns jsonb language sql stable as
    $$ select nullif(current_setting('request.jwt.claims', true), '')::jsonb $$;
    create function auth.uid() returns uuid language sql stable as $$ select (auth.jwt()->>'sub')::uuid $$;
    grant usage on schema auth to authenticated, anon;
  `)
  const migrations = new URL('../supabase/migrations/', import.meta.url)
  for (const file of (await readdir(migrations)).filter(file => file.endsWith('.sql')).sort()) {
    await db.exec(await readFile(new URL(file, migrations), 'utf8'))
  }
  return db
}

const asRole = (db, role, callback, claims = {}) => db.transaction(async tx => {
  await tx.exec('set local role ' + role)
  await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)])
  return callback(tx)
})
const stageReport = (db, payload) => asRole(db, 'service_role', async tx =>
  (await tx.query('select public.finance_stage_fundamentals($1) as result', [JSON.stringify(payload)])).rows[0].result)

test('SQL migration stages an atomic, precision-preserving version and enforces REST database roles', async t => {
  const db = await fixtureDatabase(t)
  const data = financials()
  let payload
  const sync = createFinancialStorage({ readFinancials: async () => data, readMarket: async () => market, clock,
    stage: body => { payload = body; return stageReport(db, body) } })
  const first = await sync(issue.symbol)
  assert.equal(first.status, 'staged')
  data.years[0].collectedAt = day + 'T01:00:00Z'
  assert.deepEqual(await sync(issue.symbol), { snapshotId: first.snapshotId, status: 'unchanged' })
  const amounts = (await db.query(`select account_key, current_amount::text, previous_amount::text
    from public.finance_annual_accounts order by account_key`)).rows
  assert.equal(amounts[1].current_amount, '12345678901234567890.12345')
  assert.equal(amounts[1].previous_amount, null)
  assert.equal(amounts[2].previous_amount, '0')
  assert.equal(payload.snapshot.issuer_market_cap, null)
  assert.equal(payload.snapshot.metrics.fcf.value, '12345678901234567885.12345')

  const id = '00000000-0000-4000-8000-000000000001'
  await db.query('insert into auth.users values ($1)', [id])
  await db.query("insert into public.finance_members (user_id, email, status) values ($1, 'fixture@example.test', 'approved')", [id])
  const claims = { sub: id, app_metadata: { provider: 'google' } }
  const read = (role = 'authenticated', jwt = claims) => asRole(db, role, tx =>
    tx.query('select * from public.finance_published_fundamentals').then(result => result.rows), jwt)
  assert.deepEqual(await read(), [])
  await assert.rejects(read('anon'), { code: '42501' })
  await assert.rejects(asRole(db, 'authenticated', tx => tx.query('select * from public.finance_annual_accounts'), claims), { code: '42501' })
  await assert.rejects(asRole(db, 'authenticated', tx => tx.query('select public.finance_stage_fundamentals($1)', [JSON.stringify(payload)]), claims), { code: '42501' })
  await asRole(db, 'service_role', tx => tx.query('update public.finance_fundamental_snapshots set published_at = now() where snapshot_id = $1', [first.snapshotId]))
  assert.equal((await read())[0].metrics.fcf.value, '12345678901234567885.12345')
  assert.deepEqual(await read('authenticated', { ...claims, is_anonymous: true }), [])
  assert.deepEqual(await read('authenticated', { ...claims, app_metadata: { provider: 'email' } }), [])
  for (const status of ['pending', 'rejected', 'suspended', 'approved']) {
    await db.query('update public.finance_members set status = $1 where user_id = $2', [status, id])
    assert.equal((await read()).length, status === 'approved' ? 1 : 0)
  }

  const invalid = structuredClone(payload)
  invalid.snapshot.snapshot_id = 'a'.repeat(64)
  invalid.reports[0].source_hash = 'a'.repeat(64)
  invalid.reports[0].accounts.push(invalid.reports[0].accounts[0])
  await assert.rejects(stageReport(db, invalid), { code: '23505' })
  assert.equal((await db.query('select count(*)::int as count from public.finance_annual_filings')).rows[0].count, 1)
  assert.equal((await read()).length, 1)
  await assert.rejects(stageReport(db, { ...payload, mode: 'mock' }), { code: '22023' })

  data.years[0] = { ...data.years[0], scope: 'OFS', receipt: { id: '20260402000002', filedAt: '2026-04-02', amendment: 'amended' } }
  const second = await sync(issue.symbol)
  assert.notEqual(second.snapshotId, first.snapshotId)
  assert.deepEqual(await read(), [])
  await asRole(db, 'service_role', tx => tx.query('update public.finance_fundamental_snapshots set published_at = now() where snapshot_id = $1', [second.snapshotId]))
  assert.deepEqual((await read()).map(row => row.snapshot_id), [second.snapshotId])
  const scopes = (await db.query('select scope from public.finance_annual_filings order by receipt_id')).rows.map(x => x.scope)
  assert.deepEqual(scopes, ['CFS', 'OFS'])
})

test('storage deduplicates in-flight calls and allows a safe retry after a DB failure', async () => {
  let writes = 0
  const sync = createFinancialStorage({ readFinancials: async () => financials(), readMarket: async () => market, clock,
    stage: async payload => {
      if (++writes === 1) return null
      return { snapshotId: payload.snapshot.snapshot_id, status: 'unchanged' }
    } })
  const pending = sync(issue.symbol)
  assert.equal(sync(issue.symbol), pending)
  assert.throws(() => sync('000660'), { code: 'FINANCIAL_STORAGE_BUSY' })
  await assert.rejects(pending, { code: 'FINANCIAL_STORAGE_UNAVAILABLE' })
  assert.equal((await sync(issue.symbol)).status, 'unchanged')
  assert.equal(writes, 2)
})
