-- MIGRATION #6: APPOINTMENTS, NOTIFICATIONS, TOOL-CALL TRACE, PURGE V2
-- 1. appointments: service visits, estimate visits, phone calls. One scheduled
--    appointment per business, per resource (visit = technician, call = owner),
--    per start time. Visit bookings also link a work order (EasyHVAC alignment).
-- 2. notifications: every email sent or logged (owner or customer). Immutable;
--    owners read their own.
-- 3. agent_runs.tool_calls: the tools each run called (name, input, result).
-- 4. Dev Test Shop profile: owner email, service-area ZIP prefixes, hours.
-- 5. purge_demo_data v2: everything tied to a conversation that started more
--    than 30 days ago (its lead, customer, work orders, appointments,
--    notifications) is deleted with it, plus any demo record created more than
--    30 days ago. Demo businesses only. Counts-only audit row.

-- ===== GUARD: starting state =====
do $$
begin
  if to_regclass('public.appointments') is not null or to_regclass('public.notifications') is not null then
    raise exception 'appointments aborted: tables already exist';
  end if;
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'agent_runs' and column_name = 'tool_calls') then
    raise exception 'appointments aborted: agent_runs.tool_calls already exists';
  end if;
  if (select count(*) from pg_policies where schemaname = 'public') <> 43 then
    raise exception 'appointments aborted: expected 43 public policies before migration';
  end if;
end $$;

-- ===== 1. APPOINTMENTS =====
create table public.appointments (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  lead_id uuid references public.leads (id) on delete set null,
  customer_id uuid references public.customers (id) on delete set null,
  conversation_id uuid references public.conversations (id) on delete set null,
  work_order_id uuid references public.work_orders (id) on delete set null,
  kind text not null check (kind in ('service_visit', 'estimate_visit', 'phone_call')),
  resource text generated always as (case when kind = 'phone_call' then 'call' else 'visit' end) stored,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status text not null default 'scheduled' check (status in ('scheduled', 'cancelled', 'completed')),
  source text not null default 'agent_inbound',
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint appointments_time_order check (ends_at > starts_at)
);

create unique index uq_appointments_one_per_slot
  on public.appointments (business_id, resource, starts_at)
  where status = 'scheduled';
create index idx_appointments_business_starts on public.appointments (business_id, starts_at);
create index idx_appointments_lead on public.appointments (lead_id);
create index idx_appointments_customer on public.appointments (customer_id);
create index idx_appointments_conversation on public.appointments (conversation_id);

create trigger set_updated_at before update on public.appointments
  for each row execute function private.set_updated_at();

alter table public.appointments enable row level security;
create policy "select own appointments" on public.appointments
  for select to authenticated using (business_id in (select private.user_business_ids()));
create policy "insert own appointments" on public.appointments
  for insert to authenticated with check (business_id in (select private.user_business_ids()));
create policy "update own appointments" on public.appointments
  for update to authenticated using (business_id in (select private.user_business_ids()))
  with check (business_id in (select private.user_business_ids()));
create policy "delete own appointments" on public.appointments
  for delete to authenticated using (business_id in (select private.user_business_ids()));

-- ===== 2. NOTIFICATIONS =====
create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  appointment_id uuid references public.appointments (id) on delete set null,
  lead_id uuid references public.leads (id) on delete set null,
  conversation_id uuid references public.conversations (id) on delete set null,
  channel text not null default 'email' check (channel in ('email')),
  audience text not null check (audience in ('owner', 'customer')),
  recipient text not null,
  template text not null,
  subject text,
  status text not null check (status in ('logged', 'sent', 'failed')),
  provider_message_id text,
  error_code text,
  created_at timestamptz not null default now()
);

create index idx_notifications_business_created on public.notifications (business_id, created_at desc);
create index idx_notifications_conversation on public.notifications (conversation_id);
create index idx_notifications_appointment on public.notifications (appointment_id);

alter table public.notifications enable row level security;
-- read-only to the owning business; written by the service_role only
create policy "select own notifications" on public.notifications
  for select to authenticated using (business_id in (select private.user_business_ids()));

-- ===== 3. TOOL-CALL TRACE =====
alter table public.agent_runs
  add column tool_calls jsonb not null default '[]'::jsonb
  constraint agent_runs_tool_calls_is_array check (jsonb_typeof(tool_calls) = 'array');

-- ===== 4. DEV TENANT PROFILE (merge; existing keys kept) =====
update public.businesses
   set agent_profile = agent_profile || jsonb_build_object(
     'owner_email',          'jerrykingglobal@gmail.com',
     'service_zip_prefixes', jsonb_build_array('750', '751', '752', '753', '760', '761', '762'),
     'hours',                'Mon-Fri 8 AM-5 PM Central'
   )
 where id = 'cccccccc-0000-0000-0000-000000000003';

-- ===== 5. PURGE V2 =====
create or replace function private.purge_demo_data(p_retention interval default interval '30 days')
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_cutoff     timestamptz := now() - p_retention;
  v_business   uuid;
  v_conv_ids   uuid[];
  v_lead_ids   uuid[];
  v_cust_ids   uuid[];
  v_convs      integer;
  v_msgs       integer;
  v_runs       integer;
  v_leads      integer;
  v_appts      integer;
  v_orders     integer;
  v_customers  integer;
  v_notes      integer;
  v_summary    jsonb := '[]'::jsonb;
begin
  for v_business in
    select b.id from public.businesses b
     where b.agent_profile ->> 'is_demo' = 'true'
  loop
    -- everything that hangs off an expired conversation goes with it
    v_conv_ids := array(select c.id from public.conversations c
                         where c.business_id = v_business and c.created_at < v_cutoff);
    v_lead_ids := array(select distinct c.lead_id from public.conversations c
                         where c.id = any(v_conv_ids));
    v_cust_ids := array(select distinct l.customer_id from public.leads l
                         where l.id = any(v_lead_ids) and l.customer_id is not null);

    select count(*) into v_msgs from public.messages m where m.conversation_id = any(v_conv_ids);
    select count(*) into v_runs from public.agent_runs a where a.conversation_id = any(v_conv_ids);

    with gone as (
      delete from public.notifications n
       where n.business_id = v_business
         and (n.created_at < v_cutoff or n.conversation_id = any(v_conv_ids) or n.lead_id = any(v_lead_ids))
      returning 1
    ) select count(*) into v_notes from gone;

    with gone as (
      delete from public.appointments a
       where a.business_id = v_business
         and (a.created_at < v_cutoff or a.conversation_id = any(v_conv_ids) or a.lead_id = any(v_lead_ids))
      returning 1
    ) select count(*) into v_appts from gone;

    with gone as (
      delete from public.work_orders w
       where w.business_id = v_business
         and w.source = 'agent_inbound'
         and (w.created_at < v_cutoff or w.lead_id = any(v_lead_ids))
      returning 1
    ) select count(*) into v_orders from gone;

    with gone as (
      delete from public.conversations c where c.id = any(v_conv_ids)
      returning 1
    ) select count(*) into v_convs from gone;

    with gone as (
      delete from public.leads l
       where l.business_id = v_business
         and l.source = 'agent_inbound'
         and (l.created_at < v_cutoff or l.id = any(v_lead_ids))
         and l.work_order_id is null
         and not exists (select 1 from public.conversations c where c.lead_id = l.id)
         and not exists (select 1 from public.work_orders w where w.lead_id = l.id)
      returning 1
    ) select count(*) into v_leads from gone;

    -- service_locations and units cascade from customers
    with gone as (
      delete from public.customers cu
       where cu.business_id = v_business
         and cu.source = 'agent_inbound'
         and (cu.created_at < v_cutoff or cu.id = any(v_cust_ids))
      returning 1
    ) select count(*) into v_customers from gone;

    if v_convs + v_leads + v_appts + v_orders + v_customers + v_notes > 0 then
      -- bulk purge: row_id holds the business id (no single row to point at)
      insert into public.audit_log (business_id, table_name, row_id, action, new_data)
      values (v_business, 'conversations', v_business, 'retention_purge',
              jsonb_build_object(
                'conversations', v_convs, 'messages', v_msgs, 'agent_runs', v_runs,
                'leads', v_leads, 'appointments', v_appts, 'work_orders', v_orders,
                'customers', v_customers, 'notifications', v_notes,
                'cutoff', v_cutoff));
    end if;

    v_summary := v_summary || jsonb_build_array(jsonb_build_object(
      'business_id', v_business, 'conversations', v_convs, 'messages', v_msgs,
      'agent_runs', v_runs, 'leads', v_leads, 'appointments', v_appts,
      'work_orders', v_orders, 'customers', v_customers, 'notifications', v_notes));
  end loop;

  return jsonb_build_object('cutoff', v_cutoff, 'businesses', v_summary);
end;
$$;

revoke all on function private.purge_demo_data(interval) from public;

-- ===== GUARD: ending state =====
do $$
begin
  if (select count(*) from pg_policies where schemaname = 'public') <> 48 then
    raise exception 'appointments aborted: expected 48 public policies';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and roles <> '{authenticated}') then
    raise exception 'appointments aborted: a policy is not scoped to authenticated';
  end if;
  if not exists (select 1 from pg_indexes where indexname = 'uq_appointments_one_per_slot') then
    raise exception 'appointments aborted: slot index missing';
  end if;
  if position('appointments' in (select prosrc from pg_proc where proname = 'purge_demo_data')) = 0 then
    raise exception 'appointments aborted: purge function not upgraded';
  end if;
  if has_function_privilege('anon', 'private.purge_demo_data(interval)', 'execute')
     or has_function_privilege('authenticated', 'private.purge_demo_data(interval)', 'execute') then
    raise exception 'appointments aborted: purge function executable by anon or authenticated';
  end if;
  if not exists (select 1 from cron.job where jobname = 'fieldworx-purge-demo-data' and active) then
    raise exception 'appointments aborted: purge job missing or inactive';
  end if;
end $$;
