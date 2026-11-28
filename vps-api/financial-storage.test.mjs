import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { test } from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { createFinancialStorage, storageSnapshotId } from './financial-storage-provider.mjs'

const day = '2026-11-26'
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
    create table auth.users (id uuid primary key, email text, email_confirmed_at timestamptz,
      raw_app_meta_data jsonb, is_anonymous boolean not null default false);
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

const review = (db, id, decision = 'publish', reason = null) => asRole(db, 'service_role', tx =>
  tx.query('select public.finance_review_fundamentals($1, $2, $3)', [id, decision, reason]))

test('SQL migration stages an atomic, precision-preserving version and enforces REST database roles', async t => {
  const db = await fixtureDatabase(t)
  const data = financials()
  let payload
  let now = clock()
  const sync = createFinancialStorage({ readFinancials: async () => data, readMarket: async () => market, clock: () => now,
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
  await db.query(`insert into auth.users(id,email,email_confirmed_at,raw_app_meta_data)
    values ($1,'fixture@example.test',now(),'{"provider":"google"}')`, [id])
  await db.query("insert into public.finance_members (user_id, email, status) values ($1, 'fixture@example.test', 'approved')", [id])
  const claims = { sub: id, role: 'authenticated', app_metadata: { provider: 'google' } }
  const read = (role = 'authenticated', jwt = claims) => asRole(db, role, tx =>
    tx.query('select * from public.finance_published_fundamentals').then(result => result.rows), jwt)
  assert.deepEqual(await read(), [])
  await assert.rejects(read('anon'), { code: '42501' })
  await assert.rejects(asRole(db, 'authenticated', tx => tx.query('select * from public.finance_annual_accounts'), claims), { code: '42501' })
  await assert.rejects(asRole(db, 'authenticated', tx => tx.query('select public.finance_stage_fundamentals($1)', [JSON.stringify(payload)]), claims), { code: '42501' })
  await review(db, first.snapshotId)
  assert.equal((await read())[0].metrics.fcf.value, '12345678901234567885.12345')
  assert.deepEqual(await read('authenticated', { ...claims, is_anonymous: true }), [])
  assert.deepEqual(await read('authenticated', { ...claims, app_metadata: { provider: 'email' } }), [])
  for (const changes of [
    "email_confirmed_at = null", "is_anonymous = true", "raw_app_meta_data = '{\"provider\":\"email\"}'",
  ]) {
    await db.exec('update auth.users set ' + changes)
    assert.deepEqual(await read(), [])
    await db.exec(`update auth.users set email_confirmed_at = now(), is_anonymous = false,
      raw_app_meta_data = '{"provider":"google"}'`)
  }
  assert.deepEqual(await read('authenticated', { ...claims, role: 'anon' }), [])
  await assert.rejects(read('service_role'), { code: '42501' })
  for (const table of ['issuers', 'instruments', 'annual_filings', 'annual_accounts', 'fundamental_snapshots']) {
    for (const role of ['anon', 'authenticated', 'service_role']) {
      const name = 'public.finance_' + table
      for (const sql of [`insert into ${name} default values`, `delete from ${name}`]) {
        await assert.rejects(asRole(db, role, tx => tx.exec(sql), claims), { code: '42501' })
      }
      const column = { issuers: 'corp_code', instruments: 'symbol', annual_filings: 'receipt_id',
        annual_accounts: 'account_key', fundamental_snapshots: 'publication_state' }[table]
      await assert.rejects(asRole(db, role, tx => tx.exec(`update ${name} set ${column} = ''`), claims), { code: '42501' })
      if (role !== 'service_role') await assert.rejects(asRole(db, role, tx => tx.exec('select * from ' + name), claims), { code: '42501' })
    }
  }
  await assert.rejects(asRole(db, 'authenticated', tx => tx.query(
    "select public.finance_review_fundamentals($1, 'publish')", [first.snapshotId]), claims), { code: '42501' })

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

  const published = (await read())[0]
  assert.equal(published.metrics.fcf.reportRef.year, 2025)
  assert.equal(published.metrics.fcf.reportRef.receiptId, '20260328000001')
  assert.equal(published.metrics.fcf.sources.financialCollectedAt, day + 'T00:00:00Z')
  assert.equal(published.metrics.fcf.evidence[0].accountId, 'fixture_operatingCashFlow')
  assert.equal(published.metrics.fcf.evidence[0].currency, 'KRW')
  assert.equal(new Date(published.calculated_at).toISOString(), new Date(clock()).toISOString())

  const next = structuredClone(payload)
  next.snapshot.snapshot_id = 'b'.repeat(64)
  next.snapshot.evaluation_date = '2026-11-27'
  next.snapshot.calculated_at = '2026-11-27T05:00:00Z'
  next.snapshot.symbol = '005935'
  Object.assign(next.instrument, { symbol: '005935', isin: 'KR7005931001', share_class: '우선주' })
  await Promise.all([stageReport(db, next), review(db, first.snapshotId)])
  assert.deepEqual((await read()).map(row => row.snapshot_id), [first.snapshotId])
  await assert.rejects(review(db, next.snapshot.snapshot_id, 'publish', 'invalid approval'), { code: '22023' })
  assert.deepEqual((await read()).map(row => row.snapshot_id), [first.snapshotId])
  await Promise.all([review(db, next.snapshot.snapshot_id), review(db, next.snapshot.snapshot_id)])
  assert.deepEqual((await read()).map(row => row.snapshot_id), [next.snapshot.snapshot_id])
  await assert.rejects(review(db, first.snapshotId), { code: '22023' })

  data.years[0] = { ...data.years[0], scope: 'OFS', receipt: { id: '20260402000002', filedAt: '2026-04-02', amendment: 'amended' } }
  now += 86_400_000
  const second = await sync(issue.symbol)
  assert.notEqual(second.snapshotId, first.snapshotId)
  assert.deepEqual(await read(), [])
  await review(db, second.snapshotId)
  assert.deepEqual((await read()).map(row => row.snapshot_id), [second.snapshotId])
  await review(db, second.snapshotId, 'invalidate', 'source verification error')
  assert.deepEqual(await read(), [])
  await assert.rejects(review(db, second.snapshotId), { code: '22023' })
  const stages = (await db.query(`select publication_state from public.finance_fundamental_snapshots
    order by stored_at`)).rows.map(row => row.publication_state)
  assert.deepEqual(stages, ['superseded', 'invalidated', 'invalidated'])
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

test('evaluation and valuation inputs change the snapshot identity without duplicating filings', async () => {
  const data = financials()
  let now = clock()
  let marketCap = '100000000'
  let last
  const readMarket = async () => ({ ...market, issues: [{ ...issue, tradingDate: day, marketCap }] })
  const sync = createFinancialStorage({ clock: () => now, readFinancials: async () => data, readMarket,
    stage: async payload => {
      last = payload
      return { status: 'staged', snapshotId: payload.snapshot.snapshot_id }
    } })
  async function write() {
    await sync(issue.symbol)
    return structuredClone(last)
  }
  const first = await write()
  assert.equal((await write()).snapshot.snapshot_id, first.snapshot.snapshot_id)
  now += 1000
  data.years[0].collectedAt = day + 'T01:00:00Z'
  const recollected = await write()
  assert.equal(recollected.snapshot.snapshot_id, first.snapshot.snapshot_id)
  assert.notEqual(recollected.snapshot.calculated_at, first.snapshot.calculated_at)

  marketCap = '200000000'
  const repriced = await write()
  assert.notEqual(repriced.snapshot.snapshot_id, first.snapshot.snapshot_id)
  assert.equal(repriced.reports[0].source_hash, first.reports[0].source_hash)
  assert.equal(repriced.snapshot.issuer_market_cap, null)
  assert.equal(repriced.snapshot.metrics.per.value, null)
  assert.equal(repriced.snapshot.metrics.pbr.value, null)
  now += 86_400_000
  const dated = await write()
  assert.notEqual(repriced.snapshot.snapshot_id, dated.snapshot.snapshot_id)
  assert.equal(dated.reports[0].source_hash, first.reports[0].source_hash)

  const identity = { instrument: dated.instrument, snapshot: dated.snapshot,
    versions: dated.reports.map(report => report.source_hash), market: await readMarket() }
  assert.equal(storageSnapshotId(identity), dated.snapshot.snapshot_id)
  assert.notEqual(storageSnapshotId({ ...identity, snapshot: { ...dated.snapshot, formula_version: 'next' } }), dated.snapshot.snapshot_id)
  data.years[0].receipt = { ...data.years[0].receipt, id: '20260401000002', filedAt: '2026-04-01' }
  const amended = await write()
  assert.notEqual(amended.reports[0].source_hash, first.reports[0].source_hash)
  assert.notEqual(amended.snapshot.snapshot_id, dated.snapshot.snapshot_id)
})

test('storage rejects mock and unverified identity and keeps an incomplete latest filing authoritative', async () => {
  const data = financials()
  let payload
  const sync = createFinancialStorage({ readFinancials: async () => data, readMarket: async () => market, clock,
    stage: async body => {
      payload = body
      return { status: 'staged', snapshotId: body.snapshot.snapshot_id }
    } })
  data.mode = 'mock'
  await assert.rejects(sync(issue.symbol), { code: 'FINANCIAL_STORAGE_SOURCE_UNVERIFIED' })
  delete data.mode
  data.mapping.issueAsOf = '2026-11-27'
  await assert.rejects(sync(issue.symbol), { code: 'FINANCIAL_STORAGE_IDENTITY_UNVERIFIED' })
  data.mapping.issueAsOf = day
  data.years[0].issuerCorpCode = '99999999'
  await assert.rejects(sync(issue.symbol), { code: 'FINANCIAL_STORAGE_NO_VERIFIED_FILINGS' })
  data.years[0].issuerCorpCode = corpCode
  const original = structuredClone(data.years[0])
  data.years[0].receipt.filedAt = '2026-11-27'
  await assert.rejects(sync(issue.symbol), { code: 'FINANCIAL_STORAGE_NO_VERIFIED_FILINGS' })
  data.years[0] = original
  data.years.push({ ...structuredClone(original), scope: 'OFS' })
  await assert.rejects(sync(issue.symbol), { code: 'FINANCIAL_STORAGE_NO_VERIFIED_FILINGS' })
  data.years[1] = { ...data.years[1], year: '2024', fiscalEnd: '2024-12-31',
    receipt: { id: '20250328000001', filedAt: '2025-03-28' } }
  data.years[0].accounts.pop()
  await sync(issue.symbol)
  assert.equal(payload.snapshot.metrics.fcf.value, null)
  assert.equal(payload.snapshot.metrics.fcf.reportRef.year, 2025)
  assert.equal(payload.snapshot.metrics.fcf.reportRef.scope, 'CFS')
  assert.equal(payload.reports[0].scope, 'OFS')
})
