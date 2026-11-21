-- Existing Supabase projects may grant additional privileges to service_role by default.
revoke all privileges on table public.finance_members from service_role;
grant select, insert, update on table public.finance_members to service_role;
