# Fieldworx Agent — Build State

> **Version:** v1.2
> **Last updated:** 2026-10-03 — migration #2 (hardening) pushed and verified; first live `db push` on this project.
> **Versioning:** Bump on every meaningful update and add a changelog entry below. This doc updates most often (ideally end of every build session). Format: vMAJOR.MINOR — bump MINOR for a normal session update, MAJOR when the build crosses a phase boundary (e.g. inbound done -> agent loop done -> dashboard done).

**What this file is:** The single source of truth for *where the build actually is*. Code and schema live in git (schema as Supabase migrations since v1.1). Live data and auth users live only in Supabase. This file ties them together. Update it at the end of every build session.

---

## Changelog

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
- **Agent brain:** Claude API (claude-sonnet) — not yet wired
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

### Step 3 (in progress) — Auth + Twilio inbound
- Supabase clients wired: `client.ts` (browser), `server.ts` (server/SSR), `middleware.ts` (session refresh), `admin.ts` (service_role, RLS-bypassing, `server-only`-guarded)
- Throwaway `/login` and `/test` pages exist (seed of real auth UI)
- Twilio inbound webhook live at `src/app/api/webhooks/twilio/route.ts`:
  - Validates Twilio signature (rejects forged requests)
  - Routes by matching `To` number against `inbound_numbers`
  - Creates lead -> conversation -> message chain, each stamped with `business_id`
  - Returns empty TwiML; wrapped in try/catch so Twilio doesn't retry-storm
- **VERIFIED:** real SMS from a personal phone -> Twilio -> ngrok -> webhook -> 3 correct DB rows. Signature validation passed. Full pipeline works.

---

## Current live dev state (lives in Supabase, NOT git)

- **Auth users:** `ownera@test.com` (id `dbd9fbba-8504-4d1f-91af-4d2d71ef75a6`), `ownerb@test.com` (id `8322a63a-9127-4abc-9644-ce11563fe6a2`)
- **Dev business:** "Dev Test Shop" (id `cccccccc-0000-0000-0000-000000000003`), owned by ownera
- **Registered number:** `+19726197543` (Dallas) -> Dev Test Shop, active
- **Real test data:** one lead/conversation/message chain from live SMS tests
- **Migration history:** `20261003163143 baseline` (applied by record), `20261003165843 hardening` (pushed)

---

## Next steps (in priority order)

1. **Agent response loop** — the payoff. Inbound message -> Claude API -> reply -> outbound SMS via Twilio -> outbound message stored. First system prompt.
2. **Agent tools** — check_calendar, book_appointment, get_pricing, check_service_area, lookup_customer, lookup_units, categorize_urgency, escalate_to_owner, create_work_order, update_work_order.
3. **Owner dashboard** — real UI replacing the throwaway /test page.
4. **Write-isolation live test** — proven on scratch DB; still to prove on live through the app.
5. **Deploy to Vercel** — stable public URL, off ngrok.

---

## Known gaps / risks (don't rediscover these the hard way)

- **RESOLVED v1.1:** ~~Database state not version-controlled~~ — baseline migration committed.
- **RESOLVED v1.2:** ~~`updated_at` never changes~~ — triggers added (migration #2).
- **RESOLVED v1.2:** ~~Logged-out queries error on the helper~~ — policies scoped `to authenticated`.
- **RESOLVED v1.2:** ~~Helper callable via `/rest/v1/rpc/user_business_ids`~~ — moved to `private`.
- **RESOLVED v1.2:** ~~Leaked-password protection off~~ — enabled by hand; advisor clean.
- **LESSON v1.2:** a migration that matches the live schema on paper can still fail to execute. Replay every migration on a scratch Postgres before repair or push.
- **LESSON v1.2:** secret-drop file names must start with `.env` to be gitignored. `env.dbpass` (no dot) was NOT ignored — caught before any git step. Drop scripts must check the file exists and is ignored before use.
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
- **DB-password runs** (`migration repair`, `db push`) run by hand in T3 from a script Claude provides, because T2's password scripts trip a harness path check.
- **Two witnesses:** any result that matters is confirmed by T2's output AND an independent connector read.
- **Jerry:** secrets (drop protocol), Supabase/Twilio dashboards, browser and device actions, decisions.
- **Terminals:** T1 = `npm run dev`, T2 = Claude Code, T3 = PowerShell (git/shell/by-hand scripts), T4 = ngrok.
