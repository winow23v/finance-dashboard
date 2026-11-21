create table public.finance_members (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'suspended')),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid references auth.users(id) on delete set null
);

alter table public.finance_members enable row level security;
revoke all on table public.finance_members from public, anon, authenticated;
grant select, insert, update on table public.finance_members to service_role;

create index finance_members_created_idx on public.finance_members (created_at desc, user_id);
