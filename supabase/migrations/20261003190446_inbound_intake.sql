-- MIGRATION #3: INBOUND SMS INTAKE
-- One function does all intake work in a single transaction:
--   dedupe by Twilio SID -> route To number -> reuse or create the active
--   conversation -> store the message.
-- Plus: at most one ACTIVE conversation per (business, customer number, channel),
-- enforced by the database so simultaneous first texts cannot create two.
-- Called only by the webhook through the service_role (admin) client.

-- ===== GUARD: starting state =====
do $$
begin
  if exists (select 1 from pg_proc where proname = 'ingest_inbound_sms') then
    raise exception 'intake aborted: ingest_inbound_sms already exists';
  end if;
  if exists (
    select 1 from public.conversations where status = 'active'
    group by business_id, customer_number, channel having count(*) > 1
  ) then
    raise exception 'intake aborted: duplicate active conversations exist; resolve before adding the unique index';
  end if;
end $$;

-- ===== ONE ACTIVE CONVERSATION PER CUSTOMER, PER BUSINESS, PER CHANNEL =====
create unique index uq_conversations_one_active
  on public.conversations (business_id, customer_number, channel)
  where status = 'active';

-- ===== INTAKE FUNCTION =====
create function public.ingest_inbound_sms(p_to text, p_from text, p_body text, p_sid text)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_business_id     uuid;
  v_lead_id         uuid;
  v_conversation_id uuid;
  v_message_id      uuid;
  v_is_new          boolean := false;
begin
  if coalesce(p_to, '') = '' or coalesce(p_from, '') = '' then
    return jsonb_build_object('status', 'invalid');
  end if;

  -- 1. duplicate delivery of the same Twilio message
  if p_sid is not null then
    select m.conversation_id into v_conversation_id
      from public.messages m
     where m.twilio_sid = p_sid;
    if found then
      return jsonb_build_object('status', 'duplicate', 'conversation_id', v_conversation_id);
    end if;
  end if;

  -- 2. route the destination number to a business
  select n.business_id into v_business_id
    from public.inbound_numbers n
   where n.phone_number = p_to
     and n.is_active;
  if not found then
    return jsonb_build_object('status', 'unrouted');
  end if;

  -- 3. reuse the active conversation, or create lead + conversation
  select c.id, c.lead_id into v_conversation_id, v_lead_id
    from public.conversations c
   where c.business_id = v_business_id
     and c.customer_number = p_from
     and c.channel = 'sms'
     and c.status = 'active';

  if not found then
    begin
      insert into public.leads (business_id, status, source)
      values (v_business_id, 'new', 'agent_inbound')
      returning id into v_lead_id;

      insert into public.conversations
        (business_id, lead_id, channel, customer_number, business_number, status)
      values (v_business_id, v_lead_id, 'sms', p_from, p_to, 'active')
      returning id into v_conversation_id;

      v_is_new := true;
    exception when unique_violation then
      -- A simultaneous first text created the conversation first. This block's
      -- lead insert is rolled back with it; reuse the winner's conversation.
      select c.id, c.lead_id into v_conversation_id, v_lead_id
        from public.conversations c
       where c.business_id = v_business_id
         and c.customer_number = p_from
         and c.channel = 'sms'
         and c.status = 'active';
      if not found then
        raise exception 'intake: conversation race could not be resolved';
      end if;
    end;
  end if;

  -- reused conversation (either path): record the new activity
  if not v_is_new then
    update public.conversations set updated_at = now() where id = v_conversation_id;
  end if;

  -- 4. store the message (a simultaneous duplicate delivery loses here, cleanly)
  begin
    insert into public.messages (business_id, conversation_id, direction, body, twilio_sid)
    values (v_business_id, v_conversation_id, 'inbound', p_body, p_sid)
    returning id into v_message_id;
  exception when unique_violation then
    return jsonb_build_object('status', 'duplicate', 'conversation_id', v_conversation_id);
  end;

  return jsonb_build_object(
    'status', 'stored',
    'business_id', v_business_id,
    'lead_id', v_lead_id,
    'conversation_id', v_conversation_id,
    'message_id', v_message_id,
    'conversation_is_new', v_is_new
  );
end;
$$;

-- Only the service_role (webhook) may call it.
revoke all on function public.ingest_inbound_sms(text, text, text, text) from public, anon, authenticated;
grant execute on function public.ingest_inbound_sms(text, text, text, text) to service_role;

-- ===== GUARD: ending state =====
do $$
begin
  if not exists (select 1 from pg_indexes where indexname = 'uq_conversations_one_active') then
    raise exception 'intake aborted: unique index missing';
  end if;
  if has_function_privilege('anon', 'public.ingest_inbound_sms(text,text,text,text)', 'execute')
     or has_function_privilege('authenticated', 'public.ingest_inbound_sms(text,text,text,text)', 'execute') then
    raise exception 'intake aborted: function executable by anon or authenticated';
  end if;
  if not has_function_privilege('service_role', 'public.ingest_inbound_sms(text,text,text,text)', 'execute') then
    raise exception 'intake aborted: service_role cannot execute function';
  end if;
end $$;
