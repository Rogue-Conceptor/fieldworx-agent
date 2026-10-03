-- MIGRATION #2: HARDENING
-- 1. updated_at triggers on the 9 tables that carry updated_at
-- 2. tenancy helper moved from public (exposed over REST) to private (not exposed)
-- 3. all 42 RLS policies rebuilt: same names and rules, scoped TO authenticated,
--    pointing at private.user_business_ids()
-- Runs as one transaction. Guard checks below abort the whole migration if the
-- starting or ending state is not exactly what is expected.

-- ===== GUARD: starting state =====
do $$
begin
  if (select count(*) from pg_policies where schemaname = 'public') <> 42 then
    raise exception 'hardening aborted: expected 42 public policies before migration';
  end if;
end $$;

-- ===== PRIVATE SCHEMA =====
create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated;

-- ===== 1. updated_at TRIGGER FUNCTION =====
create function private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
revoke all on function private.set_updated_at() from public;

-- ===== 2. TENANCY HELPER IN private =====
create function private.user_business_ids()
returns setof uuid
language sql
security definer
set search_path = ''
stable
as $$
  select id from public.businesses where owner_id = auth.uid();
$$;
revoke all on function private.user_business_ids() from public;
grant execute on function private.user_business_ids() to authenticated;

-- ===== 3. REBUILD POLICIES =====
do $$
declare r record;
begin
  for r in select policyname, tablename from pg_policies where schemaname = 'public'
  loop
    execute format('drop policy %I on public.%I', r.policyname, r.tablename);
  end loop;
end $$;

create policy "select own businesses" on public.businesses
  for select to authenticated using (id in (select private.user_business_ids()));
create policy "insert own businesses" on public.businesses
  for insert to authenticated with check (owner_id = auth.uid());
create policy "update own businesses" on public.businesses
  for update to authenticated using (id in (select private.user_business_ids()))
  with check (id in (select private.user_business_ids()));
create policy "delete own businesses" on public.businesses
  for delete to authenticated using (id in (select private.user_business_ids()));

-- audit_log: append-only (no update/delete policies, by design)
create policy "select own audit_log" on public.audit_log
  for select to authenticated using (business_id in (select private.user_business_ids()));
create policy "insert own audit_log" on public.audit_log
  for insert to authenticated with check (business_id in (select private.user_business_ids()));

do $$
declare t text;
begin
  foreach t in array array['customers','service_locations','units','work_orders',
                           'technicians','inbound_numbers','leads','conversations','messages']
  loop
    execute format('create policy %I on public.%I for select to authenticated using (business_id in (select private.user_business_ids()))', 'select own ' || t, t);
    execute format('create policy %I on public.%I for insert to authenticated with check (business_id in (select private.user_business_ids()))', 'insert own ' || t, t);
    execute format('create policy %I on public.%I for update to authenticated using (business_id in (select private.user_business_ids())) with check (business_id in (select private.user_business_ids()))', 'update own ' || t, t);
    execute format('create policy %I on public.%I for delete to authenticated using (business_id in (select private.user_business_ids()))', 'delete own ' || t, t);
  end loop;
end $$;

-- old exposed helper: nothing references it now
drop function public.user_business_ids();

-- ===== 1b. ATTACH updated_at TRIGGERS =====
do $$
declare t text;
begin
  foreach t in array array['businesses','customers','service_locations','units','work_orders',
                           'technicians','inbound_numbers','leads','conversations']
  loop
    execute format('create trigger set_updated_at before update on public.%I for each row execute function private.set_updated_at()', t);
  end loop;
end $$;

-- ===== GUARD: ending state =====
do $$
begin
  if (select count(*) from pg_policies where schemaname = 'public') <> 42 then
    raise exception 'hardening aborted: expected 42 public policies after rebuild';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and roles <> '{authenticated}') then
    raise exception 'hardening aborted: a policy is not scoped to authenticated';
  end if;
  if (select count(*) from pg_trigger where tgname = 'set_updated_at' and not tgisinternal) <> 9 then
    raise exception 'hardening aborted: expected 9 set_updated_at triggers';
  end if;
  if exists (select 1 from pg_proc where proname = 'user_business_ids' and pronamespace = 'public'::regnamespace) then
    raise exception 'hardening aborted: public.user_business_ids still exists';
  end if;
end $$;
