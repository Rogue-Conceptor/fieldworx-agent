-- MIGRATION #5: 30-DAY RETENTION FOR DEMO DATA
-- The live privacy policy for the Fieldworx demo promises demo conversations
-- are deleted from our systems within 30 days. This migration makes that true:
--   private.purge_demo_data(): for each business whose agent_profile has
--     is_demo = true, deletes conversations started more than 30 days ago
--     (messages and agent_runs cascade), then deletes agent-created leads
--     older than 30 days that have no conversation and no work order.
--     Writes one audit_log row per business when anything was deleted:
--     counts only, never content.
--   pg_cron runs it daily at 08:00 UTC (3:00 AM Central daylight time,
--     2:00 AM Central standard time).
-- Non-demo businesses are never touched.

-- ===== GUARD: starting state =====
do $$
begin
  if exists (select 1 from pg_proc where proname = 'purge_demo_data') then
    raise exception 'retention aborted: purge_demo_data already exists';
  end if;
end $$;

create extension if not exists pg_cron with schema pg_catalog;

-- ===== PURGE FUNCTION =====
create function private.purge_demo_data(p_retention interval default interval '30 days')
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_cutoff   timestamptz := now() - p_retention;
  v_business uuid;
  v_convs    integer;
  v_msgs     integer;
  v_runs     integer;
  v_leads    integer;
  v_summary  jsonb := '[]'::jsonb;
begin
  for v_business in
    select b.id from public.businesses b
     where b.agent_profile ->> 'is_demo' = 'true'
  loop
    -- counts first: messages and agent_runs go with their conversation (cascade)
    select count(*) into v_msgs
      from public.messages m
      join public.conversations c on c.id = m.conversation_id
     where c.business_id = v_business and c.created_at < v_cutoff;

    select count(*) into v_runs
      from public.agent_runs a
      join public.conversations c on c.id = a.conversation_id
     where c.business_id = v_business and c.created_at < v_cutoff;

    with gone as (
      delete from public.conversations c
       where c.business_id = v_business and c.created_at < v_cutoff
      returning 1
    ) select count(*) into v_convs from gone;

    -- only leads this agent created, old enough, with nothing left pointing at them
    with gone as (
      delete from public.leads l
       where l.business_id = v_business
         and l.source = 'agent_inbound'
         and l.created_at < v_cutoff
         and l.work_order_id is null
         and not exists (select 1 from public.conversations c where c.lead_id = l.id)
         and not exists (select 1 from public.work_orders w where w.lead_id = l.id)
      returning 1
    ) select count(*) into v_leads from gone;

    if v_convs > 0 or v_leads > 0 then
      -- bulk purge: row_id holds the business id (no single row to point at)
      insert into public.audit_log (business_id, table_name, row_id, action, new_data)
      values (v_business, 'conversations', v_business, 'retention_purge',
              jsonb_build_object(
                'conversations', v_convs, 'messages', v_msgs,
                'agent_runs', v_runs, 'leads', v_leads,
                'cutoff', v_cutoff));
    end if;

    v_summary := v_summary || jsonb_build_array(jsonb_build_object(
      'business_id', v_business, 'conversations', v_convs,
      'messages', v_msgs, 'agent_runs', v_runs, 'leads', v_leads));
  end loop;

  return jsonb_build_object('cutoff', v_cutoff, 'businesses', v_summary);
end;
$$;

revoke all on function private.purge_demo_data(interval) from public;

-- ===== DAILY SCHEDULE =====
select cron.schedule('fieldworx-purge-demo-data', '0 8 * * *', 'select private.purge_demo_data()');

-- ===== GUARD: ending state =====
do $$
begin
  if not exists (select 1 from cron.job where jobname = 'fieldworx-purge-demo-data' and schedule = '0 8 * * *') then
    raise exception 'retention aborted: cron job missing';
  end if;
  if has_function_privilege('anon', 'private.purge_demo_data(interval)', 'execute')
     or has_function_privilege('authenticated', 'private.purge_demo_data(interval)', 'execute') then
    raise exception 'retention aborted: purge function executable by anon or authenticated';
  end if;
end $$;
