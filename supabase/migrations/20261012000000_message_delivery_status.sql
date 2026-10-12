-- MIGRATION #9: DELIVERY STATUS PER OUTBOUND MESSAGE (fix G, Oct 11 2026)
-- 1. messages: delivery_status, delivery_error_code, delivery_updated_at.
--    Filled by Twilio status callbacks, matched on messages.twilio_sid.
-- 2. public.record_message_status(sid, status, error_code): applies one callback.
--    Twilio does not guarantee callback order, so a status only replaces a
--    lower-ranked one (queued < sending < sent < delivered/undelivered/failed < read).
--    Unknown statuses are ignored. Returns rows updated (0 = no match or stale).
--    Callable by service_role only.
-- Retention: no change; the columns are deleted with their message row.
-- Runs as one transaction. Guards abort the whole migration on any surprise.

-- ===== GUARD: starting state =====
do $$
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'messages'
                and column_name in ('delivery_status', 'delivery_error_code', 'delivery_updated_at')) then
    raise exception 'delivery_status aborted: delivery columns already exist';
  end if;
  if to_regprocedure('public.record_message_status(text,text,text)') is not null then
    raise exception 'delivery_status aborted: record_message_status already exists';
  end if;
  if (select count(*) from pg_policies where schemaname = 'public') <> 49 then
    raise exception 'delivery_status aborted: expected 49 public policies before migration';
  end if;
end $$;

-- ===== 1. COLUMNS =====
alter table public.messages
  add column delivery_status text,
  add column delivery_error_code text,
  add column delivery_updated_at timestamptz;

-- ===== 2. APPLY ONE CALLBACK =====
create function public.record_message_status(p_sid text, p_status text, p_error_code text)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_rank_new integer;
  v_rows     integer;
begin
  v_rank_new := case lower(p_status)
    when 'accepted'    then 1 when 'scheduled' then 1 when 'queued' then 1
    when 'sending'     then 2
    when 'sent'        then 3
    when 'delivered'   then 4 when 'undelivered' then 4 when 'failed' then 4
    when 'read'        then 5
    else 0 end;
  if v_rank_new = 0 or p_sid is null or p_sid = '' then
    return 0;
  end if;

  update public.messages m
     set delivery_status     = lower(p_status),
         delivery_error_code = nullif(p_error_code, ''),
         delivery_updated_at = now()
   where m.twilio_sid = p_sid
     and m.direction = 'outbound'
     and v_rank_new > case coalesce(m.delivery_status, '')
           when 'accepted' then 1 when 'scheduled' then 1 when 'queued' then 1
           when 'sending' then 2
           when 'sent' then 3
           when 'delivered' then 4 when 'undelivered' then 4 when 'failed' then 4
           when 'read' then 5
           else 0 end;
  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

revoke all on function public.record_message_status(text, text, text) from public, anon, authenticated;
grant execute on function public.record_message_status(text, text, text) to service_role;

-- ===== GUARD: ending state =====
do $$
begin
  if (select count(*) from information_schema.columns
       where table_schema = 'public' and table_name = 'messages'
         and column_name in ('delivery_status', 'delivery_error_code', 'delivery_updated_at')) <> 3 then
    raise exception 'delivery_status aborted: expected 3 delivery columns';
  end if;
  if not has_function_privilege('service_role', 'public.record_message_status(text,text,text)', 'execute') then
    raise exception 'delivery_status aborted: service_role cannot execute record_message_status';
  end if;
  if has_function_privilege('authenticated', 'public.record_message_status(text,text,text)', 'execute')
     or has_function_privilege('anon', 'public.record_message_status(text,text,text)', 'execute') then
    raise exception 'delivery_status aborted: record_message_status is executable by anon or authenticated';
  end if;
  if (select count(*) from pg_policies where schemaname = 'public') <> 49 then
    raise exception 'delivery_status aborted: policy count changed';
  end if;
end $$;
