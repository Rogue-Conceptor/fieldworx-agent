-- MIGRATION #7: EMAIL CONSENT PER CONVERSATION (fix B, decision 2a, Oct 11 2026)
-- Adds the address a customer agreed to receive email at, and when, to the
-- conversation where they agreed. Customer email is sent only when these are set.
--   1. two nullable columns on public.conversations
--   2. pair rule: both set or both empty
--   3. write guard: only service_role (the agent's webhook) may set or change them.
--      Owners keep their existing UPDATE rights on everything else.
-- Retention: no change; the columns are deleted with their conversation row.
-- Runs as one transaction. Guards abort the whole migration on any surprise.

-- ===== GUARD: starting state =====
do $$
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'conversations'
                and column_name in ('email_consent_address', 'email_consent_at')) then
    raise exception 'email_consent aborted: consent columns already exist';
  end if;
  if (select count(*) from pg_policies where schemaname = 'public' and tablename = 'conversations') <> 4 then
    raise exception 'email_consent aborted: expected 4 policies on conversations';
  end if;
end $$;

-- ===== 1. COLUMNS =====
alter table public.conversations
  add column email_consent_address text,
  add column email_consent_at timestamptz;

-- ===== 2. PAIR RULE =====
alter table public.conversations
  add constraint conversations_email_consent_pair
  check ((email_consent_address is null) = (email_consent_at is null));

-- ===== 3. WRITE GUARD =====
create function private.guard_email_consent()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user in ('service_role', 'postgres', 'supabase_admin') then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.email_consent_address is not null or new.email_consent_at is not null then
      raise exception 'email consent can only be recorded by the agent'
        using errcode = '42501';
    end if;
  elsif new.email_consent_address is distinct from old.email_consent_address
     or new.email_consent_at is distinct from old.email_consent_at then
    raise exception 'email consent can only be recorded by the agent'
      using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function private.guard_email_consent() from public;

create trigger guard_email_consent
  before insert or update on public.conversations
  for each row execute function private.guard_email_consent();

-- ===== GUARD: ending state =====
do $$
begin
  if (select count(*) from information_schema.columns
       where table_schema = 'public' and table_name = 'conversations'
         and column_name in ('email_consent_address', 'email_consent_at')) <> 2 then
    raise exception 'email_consent aborted: expected 2 consent columns';
  end if;
  if not exists (select 1 from pg_constraint where conname = 'conversations_email_consent_pair') then
    raise exception 'email_consent aborted: pair rule missing';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'guard_email_consent'
                  and tgrelid = 'public.conversations'::regclass and not tgisinternal) then
    raise exception 'email_consent aborted: write guard trigger missing';
  end if;
  if (select count(*) from pg_policies where schemaname = 'public' and tablename = 'conversations') <> 4 then
    raise exception 'email_consent aborted: conversation policies changed';
  end if;
end $$;
