# Fieldworx Agent — Testing Initiatives

> **Version:** v1.4
> **Last updated:** 2026-10-04 — retention, appointments, tools, email, viewer verified; eval harness and permanent test suites added.
> **Versioning:** Bump when a test moves from "not yet tested" to "verified," or a new open initiative is added. Log below.

**What this file is:** The register of what's been verified, how, and what still needs testing. A test that "ran successfully" is not the same as a behavior that's "proven correct." This tracks the difference.

**Principle:** Verify behavior, not just execution. "The SQL ran" != "isolation works." Prove the actual behavior through the actual path the product uses. Results that matter get two witnesses: T2's output and an independent connector read.

---

## Changelog

- **v1.4** (2026-10-04) — Verified: retention purge (scratch + live first run), migration #6 schema and purge v2, tools v1 (pure checks + no-network loop cases + live booking), real email delivery, conversation viewer incl. tenant isolation through the UI. Added three permanent test layers (unit 94, loop 16, eval 12 scenarios). Retention and privacy-page blockers resolved.
- **v1.3** (2026-10-03) — Verified: migration #3 intake (12 scratch tests incl. two concurrent-session races; live conversation reuse); migration #4 (9 scratch tests); agent classifier/formatter (19 checks); clock and history logic (13 checks); agent loop live in log mode (replied, fallback, safety, error recording, opt-in confirmation, date awareness). `updated_at` now proven on LIVE. New open items: real-send path, live STOP/HELP, superseded and send_failed paths live, retention job, scenario evals.
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

### Inbound intake function — migration #3 (2026-10-03)
Scratch Postgres, all 12 passed: unrouted number creates nothing; first text creates lead + conversation + message; second text reuses the conversation (no new lead); Twilio redelivery returns `duplicate` and creates nothing; separate conversations per customer and per business; every message stamped with its conversation's business; only `service_role` can call it; empty input returns `invalid`.
- **Race I10:** two sessions sent different first texts from the same new number at once — one conversation; the loser reused the winner's (`is_new: false`); zero orphan leads.
- **Race I11:** the same message delivered twice at once — one message stored; the loser got `duplicate`.
- **Bug found and fixed before push:** the race-recovery path skipped the `updated_at` touch.
- **Live:** two real texts reused the existing conversation; lead count unchanged.

### `updated_at` on LIVE (2026-10-03) — RESOLVED
- Reused conversation: created Jul 6, `updated_at` moved to Oct 3 2:18 PM Central on the next text. Connector witness.

### agent_runs + agent_profile — migration #4 (2026-10-03)
Scratch, all 9 passed: service_role writes; one run per inbound message (unique); bad outcome rejected; each owner reads only their own runs; owner update/delete/insert attempts blocked (history intact); anon 0 rows; profile defaults `{}` and must be a JSON object. Live: connector confirmed RLS, single read policy, 43 policies all `authenticated`, seeded persona, advisors clean.

### Agent logic — scratch checks against the real files (2026-10-03)
- **19 checks:** STOP/stop./Help/cancel -> no reply; "yes", "Yes, Tuesday works", "please stop by tomorrow" -> normal; "it's burning up in here" -> normal; burning smell / gas / CO alarm / smoke -> safety; formatter adds prefix and STOP exactly once, strips markdown, caps at a sentence boundary, hard-caps unpunctuated text at 280; history round-trip exact.
- **Bugs found by review before any live run:** `YES` would have silenced the agent on a normal "yes"; "burning" alone would have sent a 911 instruction to "it's burning up in here".
- **13 checks:** Central date formatting; next 3 business days from Saturday start Mon Oct 5 and skip weekends; Friday rolls to Monday; prompt carries date and dated slots; opt-in confirmation excluded from history; history always ends on a user turn.

### Agent loop — LIVE in log mode (2026-10-03)
- **Replied:** three-turn conversation, 2.3–3.7 s inbound to reply ready; acknowledged, triaged urgency, remembered ZIP and symptom, labeled demo windows, never promised a visit.
- **Opt-in confirmation:** new conversation received the registered text first, verbatim.
- **Date awareness:** "tomorrow" on a Saturday -> recognized Sunday, offered Mon Oct 5; honored "morning".
- **Safety:** "smell gas" -> fixed safety text, no model call, 422 ms.
- **Fallback:** model failures produced the fallback text, escalated the lead, and recorded the error.
- **Diagnosed live:** (1) Anthropic key not scoped to a workspace -> 400 on every call; fixed with a workspace key. (2) 300-token cap consumed by default adaptive thinking -> empty and cut-off replies; fixed with effort `low`, 2048 tokens, and never sending a reply that stopped at `max_tokens`.

### Retention purge — migration #5 (2026-10-04)
Scratch Postgres with pg_cron, 7 tests: demo vs real shop; clock from first message (a text sent yesterday inside a 40-day-old thread is deleted with it); lead protection (work order, other agent, recent); counts-only audit row; idempotent rerun; permissions; schedule. Live: job active `0 8 * * *`; first purge by hand deleted 1 conversation / 15 messages / 6 runs / 1 lead; 0 overdue, 0 orphans; audit row present.

### Migration #6 + purge v2 (2026-10-04)
Scratch: profile merge keeps existing keys; second visit in a booked slot blocked, call in the same slot allowed, cancel frees the slot; bad kind and end-before-start rejected; updated_at trigger; tenant isolation (A sees 3, B sees 1, B can't insert into A, anon 0); notifications immutable to owners. Purge v2: a customer created 3 days ago but tied to a 35-day-old conversation is deleted with its address, work order, appointment, and email record; recent chain, manual work order, and real shop survive. Live: 48 policies all authenticated, advisors clean, data unchanged.

### Tools, loop, email (2026-10-04)
- Pure checks (now in `npm run test:unit`, 94 cases): DST-correct slot times on both sides of Nov 1; weekend skipping; booked-slot removal; ZIP parsing (last 5-digit run); email validation; templates incl. demo disclaimer.
- No-network loop cases (now `npm run test:loop`, 16 cases / 104 checks, fetch blocked): happy booking; compensating delete; double booking; 23505 race; booked-then-model-fails -> code-built confirmation; supersede with/without writes; out of area; deadline; write-only failure escalates; per-call timeouts and retry floor; question-guardrail wiring.
- Live (log-mode SMS): text conversation booked a service visit and an estimate visit; appointments, work orders, lead, notifications confirmed by connector.
- **Real email:** two emails sent via Resend (provider IDs stored) and received in the inbox, not spam, demo disclaimer present.

### Conversation viewer (2026-10-04)
As ownera: list showed 3 conversations, matching a connector read; thread, per-message runs, expandable tool calls, and side panel (2 appointments, 2 work orders, 4 emails) rendered. As ownerb: empty list — tenant isolation through the demo UI.

### Eval harness (2026-10-04)
`npm run eval` runs the real agent (keyword gate, prompt, Claude, tools, formatter) on a fake in-memory DB; email/SMS forced to log; network fenced to api.anthropic.com. 12 scenarios: scripted single-turn (schedule-first, price shopper, are-you-real, gas, vulnerable heat, email typo) and simulated-customer multi-turn (out of area, full repair, owner call, efficient booking, moved address, email after booking). Checks on every reply: one question, no false safety alarm.

| Round | Result (--repeat=3) | Key change |
|---|---|---|
| Baseline | 21/30 (10 scenarios) | — |
| 1 | 29/36 | on-file confirmation, book by label, email after booking, one-question wording |
| 2 | 33/36 | question guardrail (code), priority order — **regression:** agent asked about gas/smoke unprompted; denials tripped the gate (11 safety firings across 8 of 9 runs) |
| 3 | 36/36, 0 false alarms | priority fixed, negation-aware gate (2-word window, "and" break), collect details before offering times |

**Safety classifier edge probes (round 3, scratch):** "There's no heat and I smell gas" and "I don't have heat I smell gas" now alarm (both missed by the first negation rule). Known false alarms remain, safe direction: "I don't see any smoke", "No gas, smoke, or CO alarm", "no sign of smoke", "I can't smell gas".

---

## NOT YET TESTED (open initiatives)

### Real outbound send (BLOCKED on A2P campaign approval)
- Flip `OUTBOUND_MODE=send`; first reply to Jerry's own phone; confirm `twilio_sid` stored on outbound messages and on the opt-in confirmation.
- Then: STOP from a real phone -> Twilio's opt-out reply, agent silent, run recorded `skipped_keyword`; HELP -> Twilio's help reply; further texts after STOP not answered.

### Agent paths not yet seen live
- `superseded` and `send_failed` live (covered by loop cases). Escalation email live (covered by loop/eval; not yet received in an inbox).

### Nightly purge run by pg_cron
- Proven by a manual run of the same function. Confirm the scheduled run executes (cron.job_run_details) after the first 3 AM run.

### Tools v1.1 (not built)
- find_my_appointments, reschedule, cancel: loop cases + eval scenarios when built.

### Eval statistical depth
- --repeat=3 is a small sample; run --repeat=10 before calling a behavior stable for a demo.

### Scenario eval suite (showcase)
- Scripted conversations run against the agent: price shopper (must not quote), emergency (safety first), returning customer, out-of-area ZIP, "are you real?" (must disclose the demo), schedule-first customer (should still triage). Record pass/fail per scenario.

### Tenant isolation — WRITE path on LIVE (HIGH)
- Proven on the scratch replica (T4/T5 above). Not yet exercised on the live project.
- **Test to run when a writing UI exists:** as User A, attempt to INSERT a row into User B's business, and UPDATE/DELETE one of B's rows, through the app. All must fail.

### Logged-out query behavior on LIVE
- Proven on scratch (T3). Live check: an anon REST read of `customers` (anon key, no session) — expect zero rows, no error. (`/test` logged out stops before querying, so it does not exercise this.)

### Idempotency against a real Twilio retry
- Duplicate delivery is proven on scratch (I4, I11). Not yet observed from an actual Twilio redelivery on live.

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
