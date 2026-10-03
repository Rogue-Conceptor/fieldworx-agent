-- MIGRATION #4: AGENT RUNS + BUSINESS AGENT PROFILE
-- 1. agent_runs: one immutable row per inbound message the agent processes.
--    Outcome, model, tokens, latency, error code. The demo's trace panel and
--    the dashboard's raw data. Written by the service_role (webhook); owners
--    can read their own; nobody can edit or delete history through the API.
-- 2. businesses.agent_profile: per-business persona and settings (JSON), so
--    the agent code stays trade-agnostic.
-- 3. Dev tenant seed: Dev Test Shop's demo persona. Updates 0 rows on any
--    database where that business does not exist.

-- ===== GUARD: starting state =====
do $$
begin
  if to_regclass('public.agent_runs') is not null then
    raise exception 'agent_runs aborted: table already exists';
  end if;
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'businesses' and column_name = 'agent_profile') then
    raise exception 'agent_runs aborted: businesses.agent_profile already exists';
  end if;
end $$;

-- ===== 1. AGENT RUNS =====
create table public.agent_runs (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  inbound_message_id uuid not null references public.messages (id) on delete cascade,
  outbound_message_id uuid references public.messages (id) on delete set null,
  outcome text not null check (outcome in
    ('replied', 'fallback', 'skipped_keyword', 'safety', 'superseded', 'send_failed', 'error')),
  outbound_mode text not null check (outbound_mode in ('log', 'send')),
  model text,
  input_tokens integer,
  output_tokens integer,
  model_latency_ms integer,
  total_latency_ms integer,
  error_code text,
  created_at timestamptz not null default now(),
  constraint uq_agent_runs_inbound_message unique (inbound_message_id)
);

create index idx_agent_runs_business_created on public.agent_runs (business_id, created_at desc);
create index idx_agent_runs_conversation on public.agent_runs (conversation_id);

alter table public.agent_runs enable row level security;

-- read-only to the owning business; no insert/update/delete policies by design
create policy "select own agent_runs" on public.agent_runs
  for select to authenticated using (business_id in (select private.user_business_ids()));

-- ===== 2. AGENT PROFILE =====
alter table public.businesses
  add column agent_profile jsonb not null default '{}'::jsonb
  constraint businesses_agent_profile_is_object check (jsonb_typeof(agent_profile) = 'object');

-- ===== 3. DEV TENANT SEED (demo persona) =====
update public.businesses
   set agent_profile = jsonb_build_object(
     'display_name',   'Fieldworx HVAC & Mechanical',
     'trade',          'HVAC',
     'program_prefix', 'Fieldworx Demo:',
     'is_demo',        true,
     'tone',           'friendly, concise, professional',
     'services',       jsonb_build_array('AC repair', 'heating repair', 'maintenance tune-ups', 'replacement estimates'),
     'service_area',   'Dallas-Fort Worth area',
     'demo_slots',     jsonb_build_array('Tuesday 2-4 PM', 'Wednesday 9-11 AM', 'Thursday 1-3 PM')
   )
 where id = 'cccccccc-0000-0000-0000-000000000003';

-- ===== GUARD: ending state =====
do $$
begin
  if not (select relrowsecurity from pg_class where oid = 'public.agent_runs'::regclass) then
    raise exception 'agent_runs aborted: RLS not enabled';
  end if;
  if (select count(*) from pg_policies where schemaname = 'public' and tablename = 'agent_runs') <> 1 then
    raise exception 'agent_runs aborted: expected exactly 1 policy on agent_runs';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and roles <> '{authenticated}') then
    raise exception 'agent_runs aborted: a policy is not scoped to authenticated';
  end if;
  if (select count(*) from pg_policies where schemaname = 'public') <> 43 then
    raise exception 'agent_runs aborted: expected 43 public policies';
  end if;
end $$;
