# Fieldworx Agent

An AI text-message agent for home-service businesses. A customer texts the shop. The agent triages the problem, collects the details, checks the service area, books a visit, and offers an email confirmation. It handles opt-outs, emergencies and returning customers without a human touching a phone.

**Live demo:** https://www.jerrster.com/fieldworx. The page has the demo number and the consent notice. The assistant plays a fictional company, "Fieldworx HVAC & Mechanical." No technician will come.

---

## How a text flows

```
 Customer SMS
     │
     ▼
 Twilio ──► /api/webhooks/twilio ── signature check (403 on fail)
                 │
                 ▼
          ingest_inbound_sms()  ── routes the number to a business; one active
                 │                 conversation per customer; duplicates dropped
                 ▼  (responds 200 right away; work continues in waitUntil)
          ┌─────────────────────────── agent run ───────────────────────────┐
          │ 1. keyword?  STOP/START/HELP family → record opt status, stay   │
          │              silent (Twilio sends the registered reply)         │
          │ 2. opted out? → skip, no model call       (check FAILS CLOSED)  │
          │ 3. rate limit? → skip, no model call                            │
          │ 4. safety phrase (gas, CO, smoke…) → fixed safety text          │
          │ 5. Claude + tools, up to 5 rounds, 45 s deadline                │
          │ 6. formatter: one question, 280-char cap, required prefix/suffix│
          └─────────────────────────────────────────────────────────────────┘
                 │
                 ▼
          Twilio send ──► statusCallback ──► /api/webhooks/twilio/status
                                             (delivered / undelivered / failed,
                                              applied forward-only)
```

Every run writes one `agent_runs` row: outcome, latency, tokens, and every tool call with its input and result. The owner dashboard (`/conversations`) shows each thread with its trace and delivery status.

## Design principles

- **The model chooses; code decides what is allowed.** Tools get the business, caller and conversation from the run, never from the model. They validate everything before writing.
- **Tool results always state a reason.** For example: `already_sent`, `no_bookings`, `not_sent_limit`. A bare zero invites the model to invent an explanation.
- **Compliance is enforced in code, not left to the prompt.** Every text starts `Fieldworx Demo:` and ends `Reply STOP to opt out.` The agent never texts first. Opt-outs are recorded per number, and the agent never runs for an opted-out number.
- **Consent is a record, not an inference.** A customer email goes out only after a "yes" in the current conversation. The consented address and time are stored, and only the agent's server role can write them.
- **A customer is a person, not a phone.** A first text from a known number gets "Am I speaking with <name>?" A different name creates a new customer, and nothing is inherited.
- **Multi-tenant from day one.** Row Level Security keyed on `business_id` isolates every table. The webhook is the only place that crosses tenants, and only to route.

## Agent tools

`check_service_area` · `get_available_slots` · `save_customer_details` · `book_appointment` (service visit, estimate visit, owner call; each visit creates a linked work order) · `escalate_to_owner`

## Guardrails on a public number

| Guard | Rule |
|---|---|
| Rate limit | 10 agent replies per number per hour, 25 per day; 100 per business per day |
| Customer email cap | 3 per number and 20 per business per 24 h; the cap check fails closed |
| Opt-out | STOP STOPALL UNSUBSCRIBE CANCEL END QUIT OPTOUT REVOKE; a Twilio 21610 also records it |
| Data retention | Demo conversations and everything created from them are purged after 30 days (pg_cron). Opt-out records are kept |

## Stack

Next.js 15 (App Router) on Vercel · Supabase Postgres with RLS + pg_cron · Twilio Programmable Messaging (A2P 10DLC registered) · Anthropic Claude · Resend

## Testing

Four layers, plus live checks with two witnesses (test output plus a direct database read; the handset for delivery):

| Command | What it covers |
|---|---|
| `npm run test:unit` | Classifiers, formatter, slot and date logic, templates, signature check, question matcher |
| `npm run test:loop` | The full agent run against an in-memory database, with the network blocked: bookings, races, opt-out, rate limits, failures |
| `npm run test:email-fail` / `test:email-cap` | Send mode with network calls stubbed to throw: failed delivery and the email caps |
| `npm run eval -- --repeat=3` | 14 conversation scenarios against the real model (price shopper, emergency, out of area, returning customer with a different name, …) |

Every migration is replayed from an empty Postgres 16 + pg_cron database and behavior-tested before it is pushed.

## Project layout

```
src/app/api/webhooks/twilio/         inbound SMS webhook (+ /status for delivery callbacks)
src/app/conversations/               owner dashboard: threads, run traces, delivery tags
src/lib/agent/                       run loop, prompt, tools, keywords, formatter, rate limit, email
src/lib/twilio/                      signature verification, status callback handler
supabase/migrations/                 schema history (RLS, intake, runs, retention, consent, opt-out…)
scripts/tests/  scripts/eval/        test harnesses and the scenario eval
```

## Running locally

Requires Node 20+. Create `.env.local` with:

`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `ANTHROPIC_API_KEY`, `RESEND_API_KEY`, `OUTBOUND_MODE` (`log` or `send`), `EMAIL_MODE` (`log` or `send`), `PUBLIC_BASE_URL` (https base for delivery callbacks), and optionally `AGENT_MODEL` / `AGENT_EFFORT`.

```
npm install
npm run dev
```

With `OUTBOUND_MODE=log` and `EMAIL_MODE=log`, nothing is sent: replies and emails are recorded only.

---

Built by Jerry King.
