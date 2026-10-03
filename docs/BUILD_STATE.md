# Fieldworx Agent — Build State

> **Version:** v2.0
> **Last updated:** 2026-10-03 — PHASE BOUNDARY: agent response loop v1 live in log mode; A2P brand approved, campaign in review.
> **Versioning:** Bump on every meaningful update and add a changelog entry below. This doc updates most often (ideally end of every build session). Format: vMAJOR.MINOR — bump MINOR for a normal session update, MAJOR when the build crosses a phase boundary (e.g. inbound done -> agent loop done -> dashboard done).

**What this file is:** The single source of truth for *where the build actually is*. Code and schema live in git (schema as Supabase migrations since v1.1). Live data and auth users live only in Supabase. This file ties them together. Update it at the end of every build session.

---

## Changelog

- **v2.0** (2026-10-03) — Phase boundary: inbound -> agent loop. Migration #3 (`ingest_inbound_sms`: one-transaction intake with dedupe, conversation reuse, race safety) and migration #4 (`agent_runs` trace table, `businesses.agent_profile`) pushed and verified. Agent loop v1 built and verified live in log mode: keyword gate, safety text, Claude replies from thread history, registered opt-in confirmation, date awareness, dated demo slots, fallback on failure, one `agent_runs` row per inbound. Anthropic key moved to a dedicated `Fieldworx` workspace. A2P: Sole Proprietor brand approved; campaign submitted and in review. Goal reframed: Fieldworx is a showcase demo for employers first.
- **v1.2** (2026-10-03) — Migration #2 `20261003165843_hardening.sql` pushed: `updated_at` triggers on 9 tables; tenancy helper moved to non-exposed `private` schema; all 42 policies rebuilt and scoped `to authenticated`. Security advisors now clean (leaked-password protection also enabled by hand). Baseline migration corrected: its policy loop quoted names with `%L` instead of `%I` and would have failed on replay — found by executing both migrations on a scratch Postgres; live DB was never affected (baseline was applied by record only). Baseline hash updated accordingly.
- **v1.1** (2026-10-03) — Adopted the project Standing Law (T2 single executor; reads via read-only connector; writes via migrations). Added a Fieldworx-scoped read-only Supabase connector. Initialized `supabase/` and linked the repo to project `zcvkyaquxfhfkssofjqs`. Captured the live schema as baseline migration `20261003163143_baseline.sql`, marked applied by record (not executed). Committed as `dfbeeac`. Logged three schema findings and two security-advisor warnings for migration #2. Project docs committed to `docs/` for the first time.
- **v1.0** — Initial creation. Captures: Step 1 (scaffold + repo), Step 2 (11-table schema + RLS, isolation verified two ways), Step 3 in progress (Supabase clients wired, Twilio inbound webhook live and verified end to end).

---

## One-paragraph project summary

Fieldworx is a multi-tenant, SMS-based missed-call callback agent for small service-trade businesses (HVAC, plumbing, electrical, etc.). When a business misses a call, the agent texts the caller back within seconds, qualifies the job through conversation, and books, quotes, or escalates to the owner. It is a true LLM agent with tool-calling, not a linear text-back script. Each business is fully isolated from every other (own account, own phone number, own data partition). The schema is deliberately aligned with a future work-order platform, EasyHVAC, so later integration is a deployment rather than a refactor.

---

## Tech stack (locked)

- **Frontend / server:** Next.js 14.2.35 (App Router, TypeScript, Tailwind, src/ dir) — pinned to 14, NOT 15
- **Database / Auth:** Supabase (Postgres, Auth, Row Level Security) — Pro plan, dedicated project `zcvkyaquxfhfkssofjqs` (us-east-1)
- **Supabase CLI:** 2.119.0 via `npx supabase` (not installed globally). No Docker on this machine.
- **SMS:** Twilio (existing account, shared with the Beacon app; Fieldworx number is separate)
- **Agent brain:** Claude API — model `claude-sonnet-5-5` (env `AGENT_MODEL`), adaptive thinking at effort `low` (env `AGENT_EFFORT`), 2048 max tokens. SDK `@anthropic-ai/sdk` 0.131. Key lives in a dedicated Anthropic workspace `Fieldworx` with its own spend limit.
- **Background work:** `@vercel/functions` `waitUntil` (no-op locally; the promise still runs)
- **Hosting:** Vercel (not yet deployed)
- **Local tunnel for dev:** ngrok (free tier — URL changes each restart)

---

## Current status: DONE and verified

### Step 1 — Scaffold + repo
- Next.js 14 scaffold, TypeScript + Tailwind + App Router + src/
- Private GitHub repo `Rogue-Conceptor/fieldworx-agent`, default branch `main`
- `.gitignore` hardened: every `.env` shape ignored — secrets cannot be committed (verified)

### Step 2 — Database schema (11 tables, two layers)
**Layer 1 — system of record (EasyHVAC-aligned):**
`businesses`, `customers`, `service_locations`, `units`, `work_orders`, `technicians`, `audit_log`

**Layer 2 — agent operational:**
`inbound_numbers`, `leads`, `conversations`, `messages`

- RLS enabled on all 11 tables; 42 policies (4 each, `audit_log` 2 — append-only by design)
- `private.user_business_ids()` SECURITY DEFINER helper (search_path locked to `''`, executable by `authenticated` only, not exposed over REST) — prevents RLS recursion on the businesses table. All policies scoped `to authenticated`; `anon` has no policies and gets zero rows.
- Tenant isolation verified TWO ways: (1) SQL impersonation, (2) through real app auth via login/test pages. Read isolation proven both directions including direct-ID reach-in. Write isolation proven on a scratch replica (v1.2), not yet on live.

### Step 2b — Schema under version control (2026-10-03)
- `supabase/` initialized in the repo and linked to `zcvkyaquxfhfkssofjqs`
- Baseline migration `supabase/migrations/20261003163143_baseline.sql` (225 lines, SHA-256 `41994032…43F4410F` after the v1.2 `%L`->`%I` fix) describes the schema exactly as live on 2026-10-03, authored from a direct read of the live DB. Replays cleanly on an empty Postgres to 11 tables / 42 policies / 35 indexes.
- Marked applied with `migration repair --status applied` — recorded, never executed
- Verified after repair via connector: history row present; 11 tables, 42 policies, 35 indexes; data unchanged
- From here on, every schema change is a new migration file -> scratch replay -> `db push --dry-run` -> `db push`

### Step 2c — Migration #2: hardening (2026-10-03)
- `20261003165843_hardening.sql` (116 lines, SHA-256 `14AA2C1B…D5E3669A`), one transaction with start/end guard checks
- `private.set_updated_at()` trigger on the 9 tables with `updated_at` (`messages` and `audit_log` have none — immutable by design)
- Helper moved `public` -> `private`; `public.user_business_ids()` dropped; `/rest/v1/rpc/user_business_ids` no longer exists
- 42 policies rebuilt with identical names and rules, scoped `to authenticated`, pointing at the private helper (41 reference it; "insert own businesses" checks `owner_id = auth.uid()` directly)
- Pre-push: replayed baseline + hardening on a scratch Postgres 16 with stubbed `auth`; 7 behavioral tests passed (see TESTING_INITIATIVES)
- Push path: dry-run named exactly one file -> push (exit 0) -> connector confirmed history, policies, roles, triggers, grants, data unchanged -> security advisors: zero warnings

### Step 2d — Migration #3: inbound intake (2026-10-03)
- `20261003190446_inbound_intake.sql` (142 lines, SHA-256 `F5B8F7EF…E391A5B0`)
- `public.ingest_inbound_sms(to, from, body, sid)`: dedupe by Twilio SID -> route -> reuse or create the active conversation -> store message, one transaction. Security invoker, search_path locked, executable by `service_role` only.
- Unique index: one ACTIVE conversation per business + customer number + channel
- Fixed: every text used to create a new lead + conversation (no multi-turn); Twilio redelivery left orphan leads; burst texts could race into two conversations
- Verified: 12 scratch tests incl. two real concurrent-session races; live reuse with real texts

### Step 2e — Migration #4: agent runs + agent profile (2026-10-03)
- `20261003193107_agent_runs.sql` (86 lines, SHA-256 `3DA6DB03…EDA85AE0`)
- `agent_runs`: one immutable row per processed inbound message — outcome, outbound mode, model, tokens, model latency, total latency, error code. Unique per inbound message. Owners read their own; no write policies (service_role writes).
- `businesses.agent_profile` (JSON object): persona and settings. Dev Test Shop seeded as Fieldworx HVAC & Mechanical, prefix `Fieldworx Demo:`.
- Policies now 43 (all `to authenticated`)

### Step 3 — Auth + Twilio inbound (done)
- Supabase clients wired: `client.ts` (browser), `server.ts` (server/SSR), `middleware.ts` (session refresh), `admin.ts` (service_role, RLS-bypassing, `server-only`-guarded)
- Throwaway `/login` and `/test` pages exist (seed of real auth UI)
- Twilio inbound webhook live at `src/app/api/webhooks/twilio/route.ts`:
  - Validates Twilio signature (rejects forged requests)
  - All intake via one `ingest_inbound_sms` rpc call (since migration #3)
  - Phone numbers masked to last 4 digits in logs; message bodies never logged
  - Returns empty TwiML; wrapped in try/catch so Twilio doesn't retry-storm
  - After `stored`, hands off to the agent via `waitUntil`
- **VERIFIED:** real SMS -> Twilio -> ngrok -> webhook -> intake function; multi-turn reuse confirmed live.

### Step 4 — Agent response loop v1 (2026-10-03)
`src/lib/agent/`: `config`, `keywords`, `prompt`, `history`, `format`, `send`, `clock`, `run`.
1. Keyword gate (code): STOP/STOPALL/UNSUBSCRIBE/CANCEL/END/QUIT/START/UNSTOP/HELP/INFO as the whole message -> no reply. Gas/CO/smoke/burning-smell/sparks -> fixed safety text, no model call.
2. New conversation -> the registered opt-in confirmation is sent first (exact text, code)
3. History: last 20 messages, prefix/suffix stripped, opt-in confirmation excluded, always starts and ends with a user turn
4. System prompt from `agent_profile` + current date/time (Central) + next 3 business days of demo windows
5. Claude call; a reply cut off at `max_tokens` or empty -> fallback text + lead escalated (partial text never sent)
6. Supersede check: a newer inbound text means skip — the newer one gets the reply
7. Code adds `Fieldworx Demo:` prefix and `Reply STOP to opt out.`; reply capped at 280 chars at a sentence boundary
8. `OUTBOUND_MODE`: `log` stores replies, never contacts Twilio (current); `send` texts for real
9. Stored outbound message + `agent_runs` row with API error type/message on failure
- **VERIFIED live (log mode):** multi-turn conversation all `replied`, 2.1–3.7 s inbound-to-reply; safety, fallback, error recording, opt-in confirmation, date awareness all observed.

---

## Current live dev state (lives in Supabase, NOT git)

- **Auth users:** `ownera@test.com` (id `dbd9fbba-8504-4d1f-91af-4d2d71ef75a6`), `ownerb@test.com` (id `8322a63a-9127-4abc-9644-ce11563fe6a2`)
- **Dev business:** "Dev Test Shop" (id `cccccccc-0000-0000-0000-000000000003`), owned by ownera
- **Registered number:** `+19726197543` (Dallas) -> Dev Test Shop, active
- **Dev Test Shop profile:** Fieldworx HVAC & Mechanical persona (seeded by migration #4)
- **Test data:** several conversations from live tests; older ones closed by hand (one-off SQL) to start fresh threads
- **Migration history:** baseline (applied by record), hardening, inbound_intake, agent_runs (pushed)
- **`.env.local` (9 vars):** Supabase URL/anon/service_role; Twilio SID/token/number; `ANTHROPIC_API_KEY`; `OUTBOUND_MODE=log`; `AGENT_MODEL=claude-sonnet-5-5`
- **A2P 10DLC (Fieldworx Twilio subaccount):** Sole Proprietor brand "Jerry King" APPROVED; Messaging Service "Fieldworx Demo" (number in sender pool, defers to the number's webhook, YES removed from opt-in keywords); campaign SUBMITTED 2026-10-03, in review. Full record: `docs/FIELDWORX_A2P_REGISTRATION.md`.

---

## Next steps (in priority order)

1. **30-day retention job** — the live privacy policy promises deletion within 30 days. Must exist before any interviewer texts the number.
2. **Prompt tuning** — triage before scheduling; never promise a check it can't perform ("so I can check that we cover your area")
3. **Conversation idle timeout** — a text after a long gap starts a new conversation and lead
4. **Agent tools** — start with `check_service_area`; then calendar/booking, lookup_customer, escalate_to_owner
5. **Demo surface** — owner dashboard + agent-run trace view (the interview showpiece)
6. **Scenario eval suite** — scripted conversations (price shopper, emergency, returning customer, out of area, "are you real?") run against the agent
7. **Next.js security decision** — before any Vercel deploy (see Known gaps)
8. **On campaign approval:** `OUTBOUND_MODE=send`, first real reply to Jerry's phone, then live STOP/HELP behavior test
9. **Deploy to Vercel** — stable public URL, off ngrok

---

## Known gaps / risks (don't rediscover these the hard way)

- **RESOLVED v1.1:** ~~Database state not version-controlled~~ — baseline migration committed.
- **RESOLVED v1.2:** ~~`updated_at` never changes~~ — triggers added (migration #2).
- **RESOLVED v1.2:** ~~Logged-out queries error on the helper~~ — policies scoped `to authenticated`.
- **RESOLVED v1.2:** ~~Helper callable via `/rest/v1/rpc/user_business_ids`~~ — moved to `private`.
- **RESOLVED v1.2:** ~~Leaked-password protection off~~ — enabled by hand; advisor clean.
- **LESSON v1.2:** a migration that matches the live schema on paper can still fail to execute. Replay every migration on a scratch Postgres before repair or push.
- **LESSON v1.2:** secret-drop file names must start with `.env` to be gitignored. `env.dbpass` (no dot) was NOT ignored — caught before any git step. Drop scripts must check the file exists and is ignored before use.
- **OPEN v2.0: Next.js 14.2.35 has a critical npm advisory** (23 advisories, fixed only in 15.x+, incl. an RCE on Windows-hosted servers). The dev server runs on Windows and is internet-reachable whenever ngrok is up. Interim rule: run ngrok only while actively testing. Upgrade decision required before any Vercel deploy. Also: axios (via twilio) high — fix available without a major bump.
- **OPEN v2.0: 30-day retention is promised in the live privacy policy but not built.** Blocker before the number is shared with anyone.
- **LESSON v2.0:** Claude Sonnet 5.x thinks by default; `max_tokens` covers thinking + text. A 300-token cap produced empty and cut-off replies. Set effort explicitly and never send a reply that stopped at `max_tokens`.
- **LESSON v2.0:** an Anthropic key created outside a workspace returns 400 "not scoped to a workspace". Keys live in the `Fieldworx` workspace.
- **LESSON v2.0:** the fetch tool can serve stale copies of jerrster.com; page source viewed in incognito is the authoritative check.
- **Unscoped "Supabase" connector on the account** (no project_ref, no read_only) can reach every project in the org, Beacon included, with write tools. Not active in Fieldworx chats. Remove or rescope.
- **No Docker.** `db pull` / `db diff` unavailable. Migrations are authored by hand and verified against the live DB via the connector.
- **Harness path check blocked T2's secret-drop script** (`Remove-Item` misread as a system path). Scripts that use the DB password may need to run by hand in T3. Never work around the check.
- **LF -> CRLF warnings** on every commit. Working copy only; committed bytes verified unchanged. A `.gitattributes` would silence it.
- **ngrok URL changes every restart** (free tier). Each dev session: restart ngrok, re-paste new URL into Twilio console.
- **Signature-validation URL reconstruction** depends on forwarded-host headers. Worked with ngrok; re-verify on Vercel.
- **Twilio account is shared with Beacon** — keep Fieldworx's number/config/credentials cleanly separated.

---

## Division of labor (how the build runs)

- **T2 (Claude Code) is the single executor:** creates/edits all files, authors migrations, runs `npx supabase` commands that need no DB password, runs git and `gh`. Writes nothing outside the working directory. Proposes any unrequested extra step before doing it.
- **Reads:** Claude (web chat) queries the DB directly through the **Fieldworx Supabase Read-Only Connector**. No SQL handed to Jerry for reads.
- **Writes:** migration file -> Claude replays it on a scratch Postgres -> `db push --dry-run` -> `db push`. Browser SQL Editor only for one-off data corrections that should not become migrations.
- **DB-password runs** (`migration repair`, `db push`) run by hand in T3 from a script Claude provides, because T2's password scripts trip a harness path check. The script checks the drop file exists and is gitignored, runs the dry run as an automatic gate (exactly one expected file), then pushes. PowerShell 5.1 prints the CLI's normal stderr as a red NativeCommandError when captured — cosmetic.
- **Two witnesses:** any result that matters is confirmed by T2's output AND an independent connector read.
- **Jerry:** secrets (drop protocol), Supabase/Twilio dashboards, browser and device actions, decisions.
- **Terminals:** T1 = `npm run dev`, T2 = Claude Code, T3 = PowerShell (git/shell/by-hand scripts), T4 = ngrok.
