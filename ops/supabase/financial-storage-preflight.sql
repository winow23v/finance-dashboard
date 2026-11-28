-- Read-only inventory for an approved target. Run before applying E-1.
-- Review the project reference separately in the Supabase Dashboard.
begin read only;

select current_database() as database_name, version() as postgres_version,
       pg_database_size(current_database()) as database_bytes,
       pg_size_pretty(pg_database_size(current_database())) as database_size;

-- Migration tracking can be absent if SQL was applied outside the Supabase CLI.
select to_regclass('supabase_migrations.schema_migrations') as migration_history;
-- If the relation exists, run this additional read-only query:
-- select version, name from supabase_migrations.schema_migrations order by version;

select name, to_regclass('public.' || name) as existing_relation
from unnest(array[
  'finance_members', 'finance_member_watchlist', 'finance_issuers',
  'finance_instruments', 'finance_annual_filings', 'finance_annual_accounts',
  'finance_fundamental_snapshots', 'finance_published_fundamentals',
  'finance_fundamental_latest_idx', 'finance_fundamental_published_idx'
]) as names(name);

select p.proname, pg_get_function_identity_arguments(p.oid) as arguments
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname in
  ('finance_stage_fundamentals', 'finance_review_fundamentals', 'finance_has_newer_filing');

select c.relname, c.relrowsecurity, pg_get_userbyid(c.relowner) as owner
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname in ('finance_members', 'finance_member_watchlist');

select grantee, table_name, privilege_type
from information_schema.table_privileges
where table_schema = 'public' and table_name in ('finance_members', 'finance_member_watchlist')
order by table_name, grantee, privilege_type;

select column_name, data_type from information_schema.columns
where table_schema = 'auth' and table_name = 'users'
  and column_name in ('id', 'email', 'email_confirmed_at', 'raw_app_meta_data', 'is_anonymous');

-- Compare the separately measured table/index projections in PR #24 against
-- the project Dashboard database disk usage and available disk allowance.
rollback;
