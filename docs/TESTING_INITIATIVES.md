# Fieldworx Agent — Testing Initiatives

> **Version:** v1.2
> **Last updated:** 2026-10-03 — first live `db push` verified; migrations replay-tested on scratch Postgres.
> **Versioning:** Bump when a test moves from "not yet tested" to "verified," or a new open initiative is added. Log below.

**What this file is:** The register of what's been verified, how, and what still needs testing. A test that "ran successfully" is not the same as a behavior that's "proven correct." This tracks the difference.

**Principle:** Verify behavior, not just execution. "The SQL ran" != "isolation works." Prove the actual behavior through the actual path the product uses. Results that matter get two witnesses: T2's output and an independent connector read.

---

## Changelog

- **v1.2** (2026-10-03) — Verified: first live `db push` (migration #2), security advisors clean, migration replay on scratch Postgres. Behavioral tests on scratch DB: read isolation, write isolation (INSERT/UPDATE/DELETE), logged-out zero rows, `updated_at` trigger, anon blocked from helper. Live behavioral confirmation of the last three still pending. Found and fixed a replay-breaking bug in the baseline.
- **v1.1** (2026-10-03) — Verified: Fieldworx connector scope; baseline migration integrity (hash, history, schema unchanged); config.toml secret scan. Added open items: `updated_at` behavior, logged-out query behavior, first live `db push`, advisor re-check after migration #2.
- **v1.0** — Initial creation. Verified: read isolation (two methods), secrets-never-committed, build integrity, Twilio inbound pipeline end to end (incl. negative routing path). Open: write isolation, agent response loop, idempotency, Vercel signature validation, multi-tenant routing at scale, auth edge cases.

---

## VERIFIED (with method)

### Tenant isolation — READ path
- **Method 1 (SQL impersonation):** Set `request.jwt.claims` to each test user, queried `customers` with no filter. User A saw only A's row; User B only B's. User A targeting B's `business_id` directly returned zero rows (not an error — invisible).
- **Method 2 (through real app auth):** Logged in as ownera via `/login`, `/test` (a server component querying `customers` with NO business_id filter) showed only Shop A's customer, count 1. Logged out, logged in as ownerb, saw only Shop B's, count 1. This proves the full chain: login -> session -> cookie -> server client -> RLS.
- **Conclusion:** Read isolation proven both directions, including deliberate direct-ID reach-in.

### Secrets never committed
- `.gitignore` covers every `.env` shape. Confirmed via `git status` that `.env.local` is invisible and absent from every commit.
- `supabase/config.toml` scanned before first commit: every secret-named setting is empty or an `env(...)` placeholder.
- DB password handled by drop protocol only: length/whitespace reported, never the value; env var and file destroyed and confirmed gone.

### Build integrity after new code
- After each set of new files, confirmed dev server compiles clean and localhost:3000 renders before committing.

### Twilio inbound pipeline (END TO END)
- **Method:** Sent a real SMS from a personal phone to `+19726197543`.
- **Verified:** Twilio reached the ngrok tunnel; webhook received the POST; **Twilio signature validation passed** (no 403); routing matched the number to Dev Test Shop; lead -> conversation -> message rows created, each correctly stamped with `business_id`; returned valid empty TwiML (200).
- **Also verified the negative path:** before the number was registered in `inbound_numbers`, the webhook correctly logged "no active inbound number... ignoring" and created NO rows.
- **Confirmed via SQL join** that lead/conversation/message rows contain correct data.

### Fieldworx read-only connector scope (2026-10-03)
- **Method:** `list_tables` returned exactly the 11 Fieldworx tables and zero Beacon tables. Direct read returned Dev Test Shop and the registered number.
- **Also confirmed:** the pre-existing "Beacon" connector reads only Beacon's project — it cannot verify Fieldworx.

### Baseline migration integrity (2026-10-03)
- **File content:** SHA-256 of the file T2 wrote matched the SHA-256 of the verified source copy (225 lines, 10,083 bytes). Same hash confirmed in the committed HEAD.
- **Source accuracy:** file authored from a direct connector read of live columns, constraints, indexes, policies, function definition and grants.
- **Recorded, not executed:** CLI `migration list` showed the version in Local and Remote; connector `list_migrations` showed `20261003163143 baseline`; table/policy/index counts (11/42/35) and row counts identical before and after repair.

### Migration replay on scratch Postgres (2026-10-03)
- **Method:** Postgres 16 in Claude's sandbox, with stubbed Supabase roles (`anon`, `authenticated`, `service_role`) and `auth` schema (`auth.users`, `auth.uid()` reading JWT claims). Replayed baseline then hardening, each in a single transaction.
- **Result:** First replay FAILED on the baseline's policy loop (`%L` quoted policy names as text). Fixed to `%I` in both files. Second replay: baseline -> 11 tables / 42 policies / 35 indexes (matches live exactly); hardening -> 42 policies all `{authenticated}`, 9 triggers, helper only in `private`; all guard checks passed.
- **Lesson:** content-matching the live schema is a structural check. Executing the file is the behavioral check. Both are required.

### Behavioral tests on scratch DB after migration #2 (2026-10-03)
Two users, two businesses, one customer each. All passed:
- **T1/T2 read isolation:** each user sees only their own customer.
- **T3 logged out:** `anon` read of `customers` returns 0 rows, no error.
- **T4 write isolation INSERT:** user A inserting into B's business -> "new row violates row-level security policy."
- **T5 write isolation UPDATE/DELETE:** user A targeting B's row -> 0 rows affected; B's row intact.
- **T6 `updated_at`:** after an update, `updated_at` moved and `created_at` did not.
- **T7 helper access:** `anon` calling `private.user_business_ids()` -> permission denied.
- **Scope:** proven on a faithful replica, NOT on the live project.

### First live `db push` — migration #2 (2026-10-03)
- **Dry run:** named exactly `20261003165843_hardening.sql`.
- **Push:** exit 0; CLI migration list shows both versions Local and Remote.
- **Connector witness:** history `baseline, hardening`; 11 tables; 42 policies all `{authenticated}`; 41 reference `private.user_business_ids` (the businesses INSERT policy uses `auth.uid()` directly); 9 `set_updated_at` triggers; helper exists only in `private`; `has_function_privilege` anon=false, authenticated=true; data unchanged (1 business, 1 message).
- **Security advisors:** zero warnings.

---

## NOT YET TESTED (open initiatives)

### Tenant isolation — WRITE path on LIVE (HIGH)
- Proven on the scratch replica (T4/T5 above). Not yet exercised on the live project.
- **Test to run when a writing UI exists:** as User A, attempt to INSERT a row into User B's business, and UPDATE/DELETE one of B's rows, through the app. All must fail.

### `updated_at` behavior on LIVE
- Triggers present on live (connector); behavior proven on scratch (T6). Live confirmation comes naturally when the agent loop first updates a lead or conversation: confirm `updated_at` moves, `created_at` does not.

### Logged-out query behavior on LIVE
- Proven on scratch (T3). Live check: an anon REST read of `customers` (anon key, no session) — expect zero rows, no error. (`/test` logged out stops before querying, so it does not exercise this.)

### Agent response loop (NOT BUILT)
- Once built: verify inbound message -> Claude API -> outbound SMS actually reaches the phone; verify the outbound message is stored (direction `outbound`); verify multi-turn conversation continuity.

### Idempotency / double-delivery
- DB unique partial index on `messages.twilio_sid` exists but hasn't been tested against an actual Twilio retry. Simulate a duplicate SID -> second insert should fail gracefully, no duplicate chain.

### Webhook signature validation on Vercel
- Passed with ngrok. Vercel's proxy/forwarded-host setup differs; re-verify after deploy or legit requests could 403.

### Multi-tenant routing at scale
- Only one registered number tested. Verify a second business + second number routes independently and never cross-contaminates.

### Auth edge cases
- Session expiry / refresh via middleware not tested over a real expiry window. Unconfirmed users, wrong passwords, logged-out access to /test — only lightly exercised.

---

## Standing test checklist (run before each commit of new code)

1. Dev server compiles clean, no red errors.
2. localhost:3000 still renders.
3. `git status` — `.env.local` NOT listed; stage by explicit path when the commit is sensitive.
4. If schema changed: migration file -> replay ALL migrations on scratch Postgres (must apply clean) -> `db push --dry-run` (names exactly the expected file) -> `db push` -> connector re-check (RLS scorecard, policy counts) -> security advisors.
5. If webhook/routing changed: send one real test SMS, confirm the chain + correct business_id via connector.
6. Any T2 claim that matters gets a connector witness before it goes into a commit message.
