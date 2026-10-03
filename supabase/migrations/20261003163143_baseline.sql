-- BASELINE: captures the Fieldworx schema exactly as it existed in the live
-- project (zcvkyaquxfhfkssofjqs) on 2026-10-03, built by hand in the SQL Editor
-- before migrations were in use. Verified against the live DB via read-only
-- connector before writing. Marked as applied via `migration repair`;
-- it was NEVER executed by db push against the live project.
-- Do not "fix" anything here. Changes go in later migrations.

-- ===== LAYER 1: SYSTEM OF RECORD =====

create table public.businesses (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete restrict,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_businesses_owner_id on public.businesses (owner_id);

create table public.customers (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  name text not null,
  phone text,
  email text,
  billing_address text,
  source text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_customers_business_id on public.customers (business_id);
create index idx_customers_phone on public.customers (business_id, phone);

create table public.service_locations (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  customer_id uuid not null references public.customers (id) on delete cascade,
  address text not null,
  access_notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_service_locations_business_id on public.service_locations (business_id);
create index idx_service_locations_customer_id on public.service_locations (customer_id);

create table public.units (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  service_location_id uuid not null references public.service_locations (id) on delete cascade,
  type text,
  brand text,
  model text,
  serial text,
  install_date date,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_units_business_id on public.units (business_id);
create index idx_units_service_location_id on public.units (service_location_id);

create table public.work_orders (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  customer_id uuid not null references public.customers (id) on delete cascade,
  service_location_id uuid references public.service_locations (id) on delete set null,
  unit_id uuid references public.units (id) on delete set null,
  status text not null default 'new',
  type text,
  scheduled_at timestamptz,
  source text not null default 'manual',
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_work_orders_business_id on public.work_orders (business_id);
create index idx_work_orders_customer_id on public.work_orders (customer_id);
create index idx_work_orders_status on public.work_orders (business_id, status);

create table public.technicians (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  user_id uuid references auth.users (id) on delete set null,
  name text not null,
  role text,
  permissions jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_technicians_business_id on public.technicians (business_id);

create table public.audit_log (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  table_name text not null,
  row_id uuid not null,
  action text not null,
  changed_by uuid references auth.users (id) on delete set null,
  old_data jsonb,
  new_data jsonb,
  created_at timestamptz not null default now()
);
create index idx_audit_log_business_id on public.audit_log (business_id);
create index idx_audit_log_row on public.audit_log (table_name, row_id);

-- ===== LAYER 2: AGENT OPERATIONAL =====

create table public.inbound_numbers (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  phone_number text not null unique,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_inbound_numbers_business_id on public.inbound_numbers (business_id);

create table public.leads (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  customer_id uuid references public.customers (id) on delete set null,
  status text not null default 'new',
  urgency text,
  source text not null default 'agent_inbound',
  work_order_id uuid references public.work_orders (id) on delete set null,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_leads_business_id on public.leads (business_id);
create index idx_leads_customer_id on public.leads (customer_id);
create index idx_leads_status on public.leads (business_id, status);

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  lead_id uuid not null references public.leads (id) on delete cascade,
  channel text not null default 'sms',
  customer_number text,
  business_number text,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_conversations_business_id on public.conversations (business_id);
create index idx_conversations_lead_id on public.conversations (lead_id);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  direction text not null,
  body text,
  twilio_sid text,
  created_at timestamptz not null default now()
);
create index idx_messages_business_id on public.messages (business_id);
create index idx_messages_conversation_id on public.messages (conversation_id);
create unique index idx_messages_twilio_sid_unique on public.messages (twilio_sid)
  where twilio_sid is not null;

-- work_orders.lead_id added after leads exists (circular link, both nullable)
alter table public.work_orders
  add column lead_id uuid references public.leads (id) on delete set null;
create index idx_work_orders_lead_id on public.work_orders (lead_id);

-- ===== TENANCY HELPER =====

create or replace function public.user_business_ids()
returns setof uuid
language sql
security definer
set search_path = public
stable
as $$
  select id from public.businesses where owner_id = auth.uid();
$$;

revoke all on function public.user_business_ids() from public, anon;
grant execute on function public.user_business_ids() to authenticated;

-- ===== ROW LEVEL SECURITY =====

alter table public.businesses        enable row level security;
alter table public.customers         enable row level security;
alter table public.service_locations enable row level security;
alter table public.units             enable row level security;
alter table public.work_orders       enable row level security;
alter table public.technicians       enable row level security;
alter table public.audit_log         enable row level security;
alter table public.inbound_numbers   enable row level security;
alter table public.leads             enable row level security;
alter table public.conversations     enable row level security;
alter table public.messages          enable row level security;

-- businesses (keyed on id; insert keyed on owner)
create policy "select own businesses" on public.businesses
  for select using (id in (select public.user_business_ids()));
create policy "insert own businesses" on public.businesses
  for insert with check (owner_id = auth.uid());
create policy "update own businesses" on public.businesses
  for update using (id in (select public.user_business_ids()))
  with check (id in (select public.user_business_ids()));
create policy "delete own businesses" on public.businesses
  for delete using (id in (select public.user_business_ids()));

-- audit_log: append-only (no update/delete policies, by design)
create policy "select own audit_log" on public.audit_log
  for select using (business_id in (select public.user_business_ids()));
create policy "insert own audit_log" on public.audit_log
  for insert with check (business_id in (select public.user_business_ids()));

-- standard four policies, keyed on business_id
do $$
declare t text;
begin
  foreach t in array array['customers','service_locations','units','work_orders',
                           'technicians','inbound_numbers','leads','conversations','messages']
  loop
    execute format('create policy %I on public.%I for select using (business_id in (select public.user_business_ids()))', 'select own ' || t, t);
    execute format('create policy %I on public.%I for insert with check (business_id in (select public.user_business_ids()))', 'insert own ' || t, t);
    execute format('create policy %I on public.%I for update using (business_id in (select public.user_business_ids())) with check (business_id in (select public.user_business_ids()))', 'update own ' || t, t);
    execute format('create policy %I on public.%I for delete using (business_id in (select public.user_business_ids()))', 'delete own ' || t, t);
  end loop;
end $$;
