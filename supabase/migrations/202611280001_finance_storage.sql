begin;

create table public.finance_issuers (
  corp_code text primary key check (corp_code ~ '^[0-9]{8}$')
);

create table public.finance_instruments (
  market text not null check (market in ('KOSPI', 'KOSDAQ')),
  symbol text not null check (symbol ~ '^[0-9A-Z]{6}$'),
  isin text not null check (isin ~ '^KR[A-Z0-9]{10}$'),
  share_class text not null,
  as_of date not null,
  corp_code text not null references public.finance_issuers,
  primary key (market, symbol, as_of)
);

create table public.finance_annual_filings (
  corp_code text not null references public.finance_issuers,
  business_year integer not null check (business_year between 2015 and 2099),
  report_code text not null check (report_code = '11011'),
  scope text not null check (scope in ('CFS', 'OFS')),
  receipt_id text not null check (receipt_id ~ '^[0-9]{14}$'),
  source_hash text not null check (source_hash ~ '^[a-f0-9]{64}$'),
  source_version integer not null check (source_version > 0),
  collected_at timestamptz not null,
  fiscal_end date,
  filed_at date,
  provenance jsonb not null,
  primary key (corp_code, business_year, report_code, scope, receipt_id, source_hash)
);

create table public.finance_annual_accounts (
  corp_code text not null,
  business_year integer not null,
  report_code text not null,
  scope text not null,
  receipt_id text not null,
  source_hash text not null,
  account_key text not null,
  current_amount numeric,
  previous_amount numeric,
  currency text check (currency ~ '^[A-Z]{3}$'),
  unit text,
  evidence jsonb not null,
  primary key (corp_code, business_year, report_code, scope, receipt_id, source_hash, account_key),
  foreign key (corp_code, business_year, report_code, scope, receipt_id, source_hash)
    references public.finance_annual_filings
);

create table public.finance_fundamental_snapshots (
  snapshot_id text primary key check (snapshot_id ~ '^[a-f0-9]{64}$'),
  corp_code text not null references public.finance_issuers,
  issuer_name text not null,
  market text not null,
  symbol text not null,
  issue_as_of date not null,
  evaluation_date date not null check (evaluation_date >= issue_as_of),
  source_observed_at timestamptz not null,
  formula_version text not null check (length(formula_version) > 0),
  coverage text not null check (coverage in ('partial-coverage', 'complete')),
  sector text,
  report_versions jsonb not null check (jsonb_typeof(report_versions) = 'array'),
  metrics jsonb not null check (jsonb_typeof(metrics) = 'object'),
  issuer_market_cap numeric check (issuer_market_cap > 0),
  per numeric generated always as ((metrics #>> '{per,searchValue}')::numeric) stored,
  pbr numeric generated always as ((metrics #>> '{pbr,searchValue}')::numeric) stored,
  roe numeric generated always as ((metrics #>> '{roe,searchValue}')::numeric) stored,
  fcf numeric generated always as ((metrics #>> '{fcf,searchValue}')::numeric) stored,
  revenue_growth numeric generated always as ((metrics #>> '{revenueGrowth,searchValue}')::numeric) stored,
  stored_at timestamptz not null default clock_timestamp(),
  published_at timestamptz,
  foreign key (market, symbol, issue_as_of) references public.finance_instruments
);

-- Resolve one eligible version per issuer. Trend and filter indexes can be evaluated
-- against the final E-3 query shapes before adding write amplification.
create index finance_fundamental_latest_idx on public.finance_fundamental_snapshots
  (corp_code, evaluation_date desc, source_observed_at desc, stored_at desc, snapshot_id desc);

alter table public.finance_issuers enable row level security;
alter table public.finance_instruments enable row level security;
alter table public.finance_annual_filings enable row level security;
alter table public.finance_annual_accounts enable row level security;
alter table public.finance_fundamental_snapshots enable row level security;

revoke all on public.finance_issuers, public.finance_instruments, public.finance_annual_filings,
  public.finance_annual_accounts, public.finance_fundamental_snapshots from public, anon, authenticated, service_role;
grant select, insert on public.finance_issuers, public.finance_instruments, public.finance_annual_filings,
  public.finance_annual_accounts, public.finance_fundamental_snapshots to service_role;
grant update (published_at) on public.finance_fundamental_snapshots to service_role;

-- The service stages one issuer in a single transaction. A repeat digest performs no
-- writes. A conflicting historical instrument identity aborts the entire transaction.
create function public.finance_stage_fundamentals(payload jsonb)
returns jsonb language plpgsql security invoker set search_path = ''
as $$
declare
  header public.finance_fundamental_snapshots;
  filing public.finance_annual_filings;
  instrument public.finance_instruments;
  report jsonb;
  refs jsonb := '[]'::jsonb;
begin
  header := jsonb_populate_record(null::public.finance_fundamental_snapshots, payload->'snapshot');
  instrument := jsonb_populate_record(null::public.finance_instruments, payload->'instrument');
  if payload->>'mode' is distinct from 'observed' or header.corp_code is null
    or header.corp_code is distinct from instrument.corp_code or header.market is distinct from instrument.market
    or header.symbol is distinct from instrument.symbol or header.issue_as_of is distinct from instrument.as_of
    or jsonb_typeof(payload->'reports') is distinct from 'array'
    or jsonb_array_length(payload->'reports') not between 1 and 3 then
    raise exception 'invalid financial storage envelope' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(header.corp_code, 0));
  if exists (select 1 from public.finance_fundamental_snapshots s where s.snapshot_id = header.snapshot_id) then
    return jsonb_build_object('snapshotId', header.snapshot_id, 'status', 'unchanged');
  end if;
  insert into public.finance_issuers values (header.corp_code) on conflict do nothing;
  insert into public.finance_instruments select instrument.* on conflict do nothing;
  if not exists (select 1 from public.finance_instruments i
      where (i.market, i.symbol, i.as_of, i.corp_code, i.isin, i.share_class)
        = (instrument.market, instrument.symbol, instrument.as_of, instrument.corp_code, instrument.isin, instrument.share_class)) then
    raise exception 'conflicting instrument identity' using errcode = '23514';
  end if;
  for report in select value from jsonb_array_elements(payload->'reports') loop
    filing := jsonb_populate_record(null::public.finance_annual_filings, report);
    if filing.corp_code is distinct from header.corp_code
      or jsonb_typeof(report->'accounts') is distinct from 'array'
      or jsonb_array_length(report->'accounts') not between 1 and 100 then
      raise exception 'invalid financial report envelope' using errcode = '22023';
    end if;
    refs := refs || jsonb_build_object('year', filing.business_year, 'scope', filing.scope,
      'receiptId', filing.receipt_id, 'sourceHash', filing.source_hash);
    insert into public.finance_annual_filings select filing.* on conflict do nothing;
    if found then
      insert into public.finance_annual_accounts
      select filing.corp_code, filing.business_year, filing.report_code, filing.scope, filing.receipt_id, filing.source_hash,
        a.account_key, a.current_amount, a.previous_amount, a.currency, a.unit, a.evidence
      from jsonb_to_recordset(report->'accounts') as a(account_key text, current_amount numeric,
        previous_amount numeric, currency text, unit text, evidence jsonb);
    end if;
  end loop;
  insert into public.finance_fundamental_snapshots
    (snapshot_id, corp_code, issuer_name, market, symbol, issue_as_of, evaluation_date, source_observed_at,
     formula_version, coverage, sector, report_versions, metrics, issuer_market_cap)
  values (header.snapshot_id, header.corp_code, header.issuer_name, header.market, header.symbol, header.issue_as_of,
    header.evaluation_date, header.source_observed_at, header.formula_version, header.coverage,
    header.sector, refs, header.metrics, header.issuer_market_cap);
  return jsonb_build_object('snapshotId', header.snapshot_id, 'status', 'staged');
end;
$$;

revoke all on function public.finance_stage_fundamentals(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.finance_stage_fundamentals(jsonb) to service_role;

-- The view owner can inspect membership and staging tables. Neither base table
-- is readable by authenticated clients. Eligibility is evaluated for every read.
create view public.finance_published_fundamentals with (security_barrier = true) as
select s.snapshot_id, s.corp_code, s.issuer_name, s.market, s.symbol, s.issue_as_of,
  s.evaluation_date, s.formula_version, s.coverage, s.sector, s.issuer_market_cap::text as issuer_market_cap,
  s.metrics, s.published_at
from public.finance_fundamental_snapshots s
where s.published_at is not null
  and s.published_at <= now()
  and auth.jwt()->>'is_anonymous' is distinct from 'true'
  and auth.jwt() #>> '{app_metadata,provider}' = 'google'
  and exists (select 1 from public.finance_members m where m.user_id = auth.uid() and m.status = 'approved')
  and not exists (select 1 from public.finance_fundamental_snapshots newer where newer.corp_code = s.corp_code
    and (newer.evaluation_date, newer.source_observed_at, newer.stored_at, newer.snapshot_id)
      > (s.evaluation_date, s.source_observed_at, s.stored_at, s.snapshot_id));

revoke all on public.finance_published_fundamentals from public, anon, authenticated, service_role;
grant select on public.finance_published_fundamentals to authenticated;
commit;
