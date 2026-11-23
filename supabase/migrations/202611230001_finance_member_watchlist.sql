create table public.finance_member_watchlist (
  user_id uuid not null references public.finance_members(user_id) on delete cascade,
  market text not null,
  exchange text not null,
  symbol text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, market, symbol),
  check (
    (market = 'KR' and exchange = 'XKRX' and symbol ~ '^[0-9A-Z]{6}$')
    or (market = 'US' and exchange in ('US', 'XNAS', 'XNYS', 'ARCX')
        and symbol ~ '^[A-Z][A-Z0-9]{0,9}(-[A-Z0-9]{1,5})?$')
  )
);

alter table public.finance_member_watchlist enable row level security;
revoke all on table public.finance_member_watchlist from public, anon, authenticated, service_role;
grant select, insert, delete on table public.finance_member_watchlist to service_role;

-- Return a single JSON value so PostgREST's row limit cannot truncate a member's list.
create function public.finance_read_watchlist(member_id uuid)
returns jsonb
language sql stable security invoker
set search_path = ''
as $$
  select coalesce(jsonb_agg(
    jsonb_build_object('market', market, 'exchange', exchange, 'symbol', symbol)
    order by created_at, market, exchange, symbol
  ), '[]'::jsonb)
  from public.finance_member_watchlist
  where user_id = member_id;
$$;

revoke all on function public.finance_read_watchlist(uuid) from public, anon, authenticated, service_role;
grant execute on function public.finance_read_watchlist(uuid) to service_role;
