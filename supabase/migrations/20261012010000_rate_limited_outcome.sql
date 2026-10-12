-- MIGRATION #10: RATE-LIMITED OUTCOME (abuse guard, Oct 11 2026)
-- agent_runs outcome gains 'rate_limited': an inbound text that was over the
-- per-number or per-business limit, so no model call and no send happened.
-- Index on agent_runs (business_id, created_at) already exists for the counts.
-- Runs as one transaction. Guards abort the whole migration on any surprise.

-- ===== GUARD: starting state =====
do $$
begin
  if position('skipped_opted_out' in (select pg_get_constraintdef(oid) from pg_constraint
       where conname = 'agent_runs_outcome_check' and conrelid = 'public.agent_runs'::regclass)) = 0 then
    raise exception 'rate_limited aborted: expected the migration #8 outcome check';
  end if;
  if position('rate_limited' in (select pg_get_constraintdef(oid) from pg_constraint
       where conname = 'agent_runs_outcome_check' and conrelid = 'public.agent_runs'::regclass)) > 0 then
    raise exception 'rate_limited aborted: rate_limited already allowed';
  end if;
  if (select count(*) from pg_policies where schemaname = 'public') <> 49 then
    raise exception 'rate_limited aborted: expected 49 public policies before migration';
  end if;
end $$;

alter table public.agent_runs drop constraint agent_runs_outcome_check;
alter table public.agent_runs add constraint agent_runs_outcome_check check (outcome in
  ('replied', 'fallback', 'skipped_keyword', 'skipped_opted_out', 'rate_limited',
   'safety', 'superseded', 'send_failed', 'error'));

-- ===== GUARD: ending state =====
do $$
begin
  if position('rate_limited' in (select pg_get_constraintdef(oid) from pg_constraint
       where conname = 'agent_runs_outcome_check' and conrelid = 'public.agent_runs'::regclass)) = 0 then
    raise exception 'rate_limited aborted: outcome check missing rate_limited';
  end if;
  if (select count(*) from pg_policies where schemaname = 'public') <> 49 then
    raise exception 'rate_limited aborted: policy count changed';
  end if;
end $$;
