-- MIGRATION #8: SMS OPT-OUT STATUS PER NUMBER (fix E, Oct 11 2026)
-- 1. sms_opt_status: one row per business + phone. Records STOP/START keywords
--    and Twilio 21610 refusals, so the agent never runs for an opted-out number.
--    Written by the service_role only; owners can read their own.
--    RETENTION: deliberately NOT part of the 30-day demo purge (decision Oct 11,
--    option a). An opt-out must be honored after the conversation is deleted.
-- 2. agent_runs.keyword: which keyword a skipped_keyword run received.
-- 3. agent_runs outcome: adds 'skipped_opted_out'.
-- Runs as one transaction. Guards abort the whole migration on any surprise.

-- ===== GUARD: starting state =====
do $$
begin
  if to_regclass('public.sms_opt_status') is not null then
    raise exception 'sms_opt_status aborted: table already exists';
  end if;
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'agent_runs' and column_name = 'keyword') then
    raise exception 'sms_opt_status aborted: agent_runs.keyword already exists';
  end if;
  if not exists (select 1 from pg_constraint where conname = 'agent_runs_outcome_check'
                  and conrelid = 'public.agent_runs'::regclass) then
    raise exception 'sms_opt_status aborted: agent_runs_outcome_check not found';
  end if;
  if (select count(*) from pg_policies where schemaname = 'public') <> 48 then
    raise exception 'sms_opt_status aborted: expected 48 public policies before migration';
  end if;
end $$;

-- ===== 1. SMS OPT STATUS =====
create table public.sms_opt_status (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  phone text not null constraint sms_opt_status_phone_e164 check (phone ~ '^\+[1-9][0-9]{6,14}$'),
  status text not null check (status in ('opted_out', 'opted_in')),
  last_keyword text,
  source text not null check (source in ('keyword', 'twilio_21610')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint uq_sms_opt_status_business_phone unique (business_id, phone)
);

create trigger set_updated_at before update on public.sms_opt_status
  for each row execute function private.set_updated_at();

alter table public.sms_opt_status enable row level security;

-- read-only to the owning business; written by the service_role only
create policy "select own sms_opt_status" on public.sms_opt_status
  for select to authenticated using (business_id in (select private.user_business_ids()));

-- ===== 2. KEYWORD ON AGENT RUNS =====
alter table public.agent_runs add column keyword text;

-- ===== 3. NEW OUTCOME =====
alter table public.agent_runs drop constraint agent_runs_outcome_check;
alter table public.agent_runs add constraint agent_runs_outcome_check check (outcome in
  ('replied', 'fallback', 'skipped_keyword', 'skipped_opted_out', 'safety', 'superseded', 'send_failed', 'error'));

-- ===== GUARD: ending state =====
do $$
begin
  if not (select relrowsecurity from pg_class where oid = 'public.sms_opt_status'::regclass) then
    raise exception 'sms_opt_status aborted: RLS not enabled';
  end if;
  if (select count(*) from pg_policies where schemaname = 'public' and tablename = 'sms_opt_status') <> 1 then
    raise exception 'sms_opt_status aborted: expected exactly 1 policy on sms_opt_status';
  end if;
  if (select count(*) from pg_policies where schemaname = 'public') <> 49 then
    raise exception 'sms_opt_status aborted: expected 49 public policies';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and roles <> '{authenticated}') then
    raise exception 'sms_opt_status aborted: a policy is not scoped to authenticated';
  end if;
  if position('skipped_opted_out' in (select pg_get_constraintdef(oid) from pg_constraint
       where conname = 'agent_runs_outcome_check' and conrelid = 'public.agent_runs'::regclass)) = 0 then
    raise exception 'sms_opt_status aborted: outcome check missing skipped_opted_out';
  end if;
end $$;
