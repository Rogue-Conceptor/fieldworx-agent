# Fieldworx Agent — Build State

> **Version:** v3.0
> **Last updated:** 2026-10-04 — PHASE BOUNDARY: the agent acts (tools, bookings, email) and the demo surface is live (conversation viewer); eval harness and permanent tests in place.
> **Versioning:** Bump on every meaningful update and add a changelog entry below. This doc updates most often (ideally end of every build session). Format: vMAJOR.MINOR — bump MINOR for a normal session update, MAJOR when the build crosses a phase boundary (e.g. inbound done -> agent loop done -> dashboard done).

**What this file is:** The single source of truth for *where the build actually is*. Code and schema live in git (schema as Supabase migrations). Live data and auth users live only in Supabase. This file ties them together. Update it at the end of every build session.

---

## Changelog

- **v3.0** (2026-10-04) — Phase boundary: talking agent -> acting agent + demo surface. Migration #5 (30-day retention purge, pg_cron nightly) and migration #6 (appointments, notifications, tool-call trace, purge v2). Agent tools v1: slots, service area, customer details, booking (service visit / estimate visit / phone call), escalation. Real email via Resend on verified `notify.jerrster.com`. Conversation viewer at `/conversations` (live thread + agent-run trace). Eval harness (12 scenarios, simulated customer, `--repeat`): baseline 21/30 -> 36/36 after three tuning rounds. Permanent tests: `npm run test:unit` (94), `npm run test:loop` (16 cases / 104 checks). Privacy page updated twice to match what the system collects and deletes. Retention blocker CLEARED.
- **v2.0** (2026-10-03) — Phase boundary: inbound -> agent loop. Migrations #3 (intake function) and #4 (agent_runs, agent_profile). Agent loop v1 live in log mode. A2P brand approved; campaign submitted. Goal reframed: showcase demo for employers first.
- **v1.2** (2026-10-03) — Migration #2 hardening (updated_at triggers, helper to private schema, policies to authenticated); baseline replay bug fixed.
- **v1.1** (2026-10-03) — Standing Law adopted; Fieldworx read-only connector; schema captured as baseline migration; docs into the repo.
- **v1.0** — Initial creation: scaffold, 11-table schema + RLS, Twilio inbound verified.

---

## One-paragraph project summary

Fieldworx is a multi-tenant, SMS-based AI agent for small service-trade businesses. A customer texts the business; the agent qualifies the job, checks the service area, saves the customer's details, and books a service visit, an estimate visit, or a phone call with the owner — or escalates an emergency to the owner — then confirms by text and email. Every action goes through a tool with deterministic checks in code; every run is traced. Built first as a showcase for employers, on a production-shaped foundation: tenant isolation by Row Level Security, migrations with replay tests, two-witness verification, and an eval harness that measures the agent's judgment.

---

## Tech stack (locked)

- **Frontend / server:** Next.js 14.2.35 (App Router, TypeScript, Tailwind, src/) — pinned to 14 (see Known gaps: security advisory)
- **Database / Auth:** Supabase Pro, project `zcvkyaquxfhfkssofjqs` (us-east-1). pg_cron enabled.
- **Supabase CLI:** 2.119.0 via `npx supabase`. No Docker.
- **SMS:** Twilio, Fieldworx subaccount (separate from Beacon), number +1 972-619-7543
- **Agent brain:** Claude API — `claude-sonnet-5-5` (env `AGENT_MODEL`), adaptive thinking, effort `low` (env `AGENT_EFFORT`), 2048 max tokens; key in Anthropic workspace `Fieldworx`
- **Email:** Resend, sending domain `notify.jerrster.com` (verified; DNS on Squarespace), from `bookings@notify.jerrster.com`
- **Eval / tests:** `tsx`, `server-only` (dev); simulated customer on `claude-haiku-4-5-20251001`
- **Hosting:** Vercel (not yet deployed). Local tunnel: ngrok (free; URL changes each restart)

---

## What's built and verified

### Data layer — 6 migrations
| # | Migration | What |
|---|---|---|
| 1 | `20261003163143_baseline` | 11 tables, RLS, helper (applied by record; replays clean) |
| 2 | `20261003165843_hardening` | updated_at triggers; helper -> `private`; 42 policies `to authenticated` |
| 3 | `20261003190446_inbound_intake` | `ingest_inbound_sms()`: dedupe, routing, conversation reuse, race-safe |
| 4 | `20261003193107_agent_runs` | `agent_runs` trace table; `businesses.agent_profile` |
| 5 | `20261004231314_retention` | `private.purge_demo_data()` + pg_cron job daily 08:00 UTC (3 AM Central DST / 2 AM CST) |
| 6 | `20261004235143_appointments` | `appointments` (one per slot per resource), `notifications`, `agent_runs.tool_calls`, profile (owner email, ZIP prefixes, hours), purge v2 |

48 policies, all `to authenticated`. Security advisors: zero warnings.

**Retention (purge v2):** demo businesses only. Deletes every conversation started > 30 days ago and everything tied to it — lead, customer and service locations, agent-created work orders, appointments, notifications, messages, agent runs — plus any demo record created > 30 days ago. Manual work orders and non-demo businesses are never touched. One counts-only audit_log row per purge. First live run (2026-10-04): 1 conversation, 15 messages, 6 runs, 1 lead deleted.

### Inbound
Twilio webhook -> signature check -> `ingest_inbound_sms` rpc -> hand-off to the agent (`waitUntil`). Phone numbers masked in logs; bodies never logged. `maxDuration = 60`.

### Agent (src/lib/agent/)
1. **Keyword gate (code):** STOP/START/HELP etc. -> no reply. Hazard phrases (gas, CO, smoke, burning smell, sparks) -> fixed safety text, no model call. **Negation-aware:** a negator within the 2 words before a phrase, or an "or/nor" continuation of a denied phrase, counts as a denial; clauses break at punctuation and but/though/however/and. Errs toward alarming.
2. **Opt-in confirmation (code):** first message of a new conversation, exact registered text.
3. **Context:** last 20 messages + a fresh **"on file"** block from the database (customer, address, booked appointments) + current Central date/time + shop facts from `agent_profile`.
4. **Tool loop:** up to 5 tool rounds; thinking blocks replayed unmodified; 45 s run deadline with per-call timeouts capped to time remaining (no retry under 12 s left).
5. **Tools:** `get_available_slots`, `check_service_area`, `save_customer_details`, `book_appointment`, `escalate_to_owner`. Business, caller number, conversation, and lead always come from run context, never from the model. `book_appointment` takes the slot as offered (label or ISO), re-checks availability, name, address, area, and duplicates; visits create a linked work order (compensating delete on failure); 23505 race -> "just taken".
6. **Email:** owner on every booking/escalation; customer if an email is on file (also sent if the email arrives after booking). `EMAIL_MODE` gate (`log` / `send`).
7. **Formatter (code):** first question only (extra question sentences dropped — guardrail with event + log), 280-char cap at a sentence boundary, `Fieldworx Demo:` prefix, `Reply STOP to opt out.` suffix.
8. **Failure handling:** booked-then-failed -> code-built confirmation, lead stays booked; nothing booked -> fallback text + lead escalated. Supersede (newer text arrived) only skips the reply if nothing was written.
9. **Trace:** one `agent_runs` row per inbound: outcome, tokens, latencies, error code, every tool call (name, ok, wrote, ms, input, result).

### Demo surface
`/conversations` (list) and `/conversations/[id]` (thread, per-message run trace with expandable tool calls, side panel: customer, lead, appointments, work orders, emails). Live refresh every 3 s. Owner session only (RLS); phone numbers masked. Login lands here.

### Live proofs (log-mode SMS, real email)
- Real text conversation booked a service visit (Mon Oct 5, 9-11 AM) and then an estimate visit (1-3 PM): appointments, work orders, lead, and notifications confirmed in the database.
- Two emails **sent** via Resend and received in the inbox (not spam), demo disclaimer present.
- Viewer: ownera sees 3 conversations (matches database); ownerb sees 0.

### Tests
| Command | Covers | Result |
|---|---|---|
| `npm run test:unit` | classifier (incl. negation), formatter, guardrail, history, area, clock/DST, email templates, tools/prompt/notify | 94/94 |
| `npm run test:loop` | tool-loop control flow: booking, compensating delete, double booking, race, booked-then-failed, supersede, out of area, deadline, retry floor, guardrail wiring; fetch blocked | 16/16 (104 checks) |
| `npm run eval -- --repeat=3` | agent judgment, 12 scenarios, real model, fake DB, network fenced to Anthropic | 36/36, 0 false safety alarms |

---

## Current live dev state (Supabase, not git)

- **Auth users:** ownera@test.com (owns Dev Test Shop), ownerb@test.com (owns nothing). Passwords in Jerry's password manager.
- **Dev Test Shop** (`cccccccc-0000-0000-0000-000000000003`): persona Fieldworx HVAC & Mechanical, `is_demo: true`, owner email jerrykingglobal@gmail.com, ZIP prefixes 750-753 / 760-762, hours Mon-Fri 8 AM-5 PM Central.
- **Data:** 3 conversations (2 closed test threads, 1 active with two bookings for "John Smith").
- **`.env.local` (11 vars):** Supabase x3, Twilio x3, `ANTHROPIC_API_KEY`, `OUTBOUND_MODE=log`, `AGENT_MODEL`, `RESEND_API_KEY`, `EMAIL_MODE` (**set to `log` when not actively testing**).
- **A2P:** brand "Jerry King" approved; Messaging Service "Fieldworx Demo"; campaign submitted 2026-10-03, in review.
- **Privacy page** (`/fieldworx/privacy`): updated 2026-10-04 — names collected on booking, Resend as a provider, retention covering bookings. Verified by page source in incognito.

---

## Next steps (in priority order)

1. **Tools v1.1:** `find_my_appointments`, reschedule/cancel (approved scope)
2. **Conversation idle timeout** — a text after a long gap starts a new conversation and lead
3. **Safety gate:** add "can't" / "cannot" negators with cases
4. **Owner summary** — the "8 calls, 5 booked, 1 emergency" view on top of the viewer
5. **Next.js security decision** — required before any Vercel deploy
6. **Deploy to Vercel** — stable URL; re-verify webhook signature behind Vercel's proxy
7. **On campaign approval:** `OUTBOUND_MODE=send`; first real reply to Jerry's phone; live STOP/HELP tests
8. Portfolio: link the demo from jerrster.com once deployed

---

## Known gaps / risks

- **OPEN: Next.js 14.2.35 critical advisory** (fixes only in 15+; includes a Windows-host RCE). Dev server on Windows is internet-reachable while ngrok runs. Rule: ngrok only while testing. Decide before deploy.
- **OPEN: email in `send` mode emails any address typed into a conversation.** Use only your own address when testing; set `EMAIL_MODE=log` when done.
- **OPEN: known safety false alarms** (safe direction): "I don't see any smoke", "No gas, smoke, or CO alarm", "no sign of smoke", "I can't smell gas". A comma-list rule was rejected: it would read "No heat, smoke everywhere" as a denial.
- **Eval cannot exercise the safety classifier** now that the prompt no longer raises hazards; the unit tests carry that coverage.
- **Unscoped "Supabase" connector** on the account (no project_ref, write tools) — remove or rescope.
- **npm audit:** 15 vulnerabilities including next (critical) and axios via twilio (high).
- **No Docker:** migrations authored by hand, replayed on a scratch Postgres (with pg_cron) before every push.
- **ngrok URL changes each restart** — re-paste into Twilio.
- **LF -> CRLF warnings** on commit — cosmetic; committed bytes verified.
- **RESOLVED v3.0:** ~~30-day retention not built~~ — migration #5/#6, live purge proven. ~~Privacy page out of date~~ — updated and verified.

### Lessons (v3.0)
- **A prompt instruction is code with no type checker.** "safety" in a priority list was read as "ask about safety"; denials then tripped the keyword gate (11 safety firings across 8 of 9 runs). Pass counts went up while behavior got worse — only reading transcripts caught it.
- **Fixing false alarms can create misses.** The first negation rule missed "There's no heat and I smell gas." Safety rules get asymmetric design: a false alarm is embarrassing, a miss is the failure.
- **Scripted customers can't test an agent that legitimately varies its path.** Use a simulated customer for multi-turn goals; check end state.
- **Changing a check after a failure** must be justified in the open (scenario 6: turns-to-booking replaced turns-to-DONE).
- **Scratch tests rot.** The 19 earlier classifier cases had to be reconstructed from docs; all tests are now permanent.
- **Commit-message figures must be arithmetic-checked.** 5360fa3 said "11 of 12 runs" (3 x 3 = 9); corrected in 26e3fa0 rather than rewriting pushed history.
- **The fetch tool caches jerrster.com;** incognito page source is the authoritative check.
- **Claude Code auto mode** auto-approved a recursive delete; manual mode is the rule. Never choose "don't ask again" or "switch to auto mode".

---

## Division of labor

- **T2 (Claude Code):** single executor — files, migrations, `npx supabase` without the DB password, git, `gh`, test and eval runs. Writes nothing outside the working directory. Proposes unrequested checks before running them. Manual approval mode only.
- **Reads:** Claude (web) via the Fieldworx read-only connector.
- **Schema writes:** migration -> Claude replays all migrations on scratch Postgres + behavioral tests -> T2 writes the file (hash-gated; long files via download into `FIELDWORX APPS` then byte-copy) -> Jerry runs the gated dry-run + push script in T3 -> connector witness + advisors.
- **Two witnesses** for every result that matters; claims in commit messages state who observed them.
- **Jerry:** secrets (drop protocol), dashboards (Supabase, Twilio, Resend, Squarespace), device/browser checks, decisions.
- **Terminals:** T1 `npm run dev` · T2 Claude Code · T3 PowerShell · T4 ngrok.
