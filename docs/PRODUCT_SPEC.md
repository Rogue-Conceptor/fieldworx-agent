# Fieldworx Agent — Product Spec

> **Version:** v1.1
> **Last updated:** 2026-10-04 — goal reframed to showcase-first; tool set, email confirmations, A2P per-tenant reality, retention as product behavior.
> **Versioning:** Bump on meaningful change and log below. This doc changes rarely — only when a product decision, architecture principle, or scope item actually changes. Day-to-day build progress does NOT belong here (that's BUILD_STATE.md).

**What this file is:** The stable "what we're building and why" reference. Changes rarely. For *where the build is*, see BUILD_STATE.md.

---

## Changelog

- **v1.1** (2026-10-04) — Product decisions recorded: showcase-for-employers is the first goal (revenue later, same codebase); agent actions v1 and v1.1; email confirmations; agent never texts first (A2P campaign constraint); each production tenant needs its own A2P registration (ISV onboarding); demo data retention is a product behavior; demo persona carries a visible demo disclosure.
- **v1.0** — Initial creation. Captures product summary, agent-vs-workflow thesis, architecture principles (multi-tenant, two-layer schema, Model B lead entity, work-order-links-to-lead, append-only audit, routing-vs-RLS), planned v1 tools, locked product decisions, data/IP constraints, business context.

---

## The product in one paragraph

When a small service-trade business misses an inbound call, Fieldworx texts the caller back within seconds, qualifies the job through SMS conversation, and either books it on the owner's calendar, gives a ballpark quote, or escalates to the owner — all without the owner touching their phone. The owner wakes up to a dashboard: "8 calls came in. 5 booked. 2 quoted. 1 emergency — I called you." It replaces 50-70% of what a front-office manager does. Trade-agnostic at the product layer; vertical positioning is marketing copy only.

## Why an agent, not a workflow

The happy path ("we'll call you back") is commoditized at ~$39/mo (Numa, Textline). The other 70% of real conversations are messy — pricing questions, urgency triage, returning customers, reschedules, emergencies. A decision tree breaks within two replies. An LLM reading intent with tools to take action handles them. That capability is what justifies the $147/mo price ceiling.

---

## Architecture principles (the decisions, and the why)

### Multi-tenant from day one
Each business = own owner account, own Twilio number, own data partition. Enforced at the database by Row Level Security keyed on `business_id`, not by app-layer filtering. The database refuses to leak; app code cannot forget to add a filter. Proven: one tenant cannot read another's rows even when targeting them by explicit ID.

### Two-layer schema
- **Layer 1 (system of record):** durable business records, aligned with the future EasyHVAC platform so integration later is a deployment, not a refactor.
- **Layer 2 (agent operational):** the SMS-agent-specific tables. This layer is why the schema is more than "just EasyHVAC."

### Lead as a separate entity (Model B)
A **lead** is the durable, channel-agnostic *business intent*. A **conversation** is one communication thread on one channel. A **message** is one SMS. Leads were split from conversations deliberately: future agents (quote agent, re-engagement agent) and EasyHVAC will attach to a lead independent of any SMS thread. A re-engagement agent creates a lead with no conversation at all. Discipline: no channel info (phone numbers) ever appears on the lead — if it does, the abstraction is leaking.

### Work order links to the lead, not the conversation
The lead is the canonical intent that converts. The conversation is reachable via one indexed hop. One source of truth beats one saved join.

### Audit log is append-only
Enforced structurally by omitting UPDATE/DELETE RLS policies. You can write and read history; you cannot rewrite it.

### Routing vs. RLS are distinct
Routing (matching an inbound `To` number to a business) is app-level logic in the webhook, using the admin client. RLS is database-level enforcement. Both are necessary; neither replaces the other. The webhook is the one place that deliberately crosses tenant boundaries — because it decides *which* tenant a message belongs to before any tenant context exists.

---

## Goal (as of 2026-10-04)

**First: a showcase.** A live, texted demo that proves agent-building skill to employers — real phone number, real replies, real bookings and email, with the reasoning visible in a trace viewer. **Later: the business** described below, on the same codebase. Multi-tenancy and the EasyHVAC-aligned schema stay first-class so the later path needs no rewrite.

## Agent actions — decided

| Version | Actions |
|---|---|
| v1 (built) | book service visit · book estimate visit (someone comes out to price; the agent never quotes) · schedule phone call with the owner · check service area · save customer details · escalate to owner · answer shop facts from the profile |
| v1.1 (approved) | find my appointments · reschedule · cancel |
| Excluded for now | reminders, review requests, follow-ups, re-engagement — anything where the agent texts first. The registered campaign promises the assistant never starts a conversation. |

**Confirmations:** the owner gets an email for every booking and escalation; the customer gets one if they give an email (optional; asked once). Emails come from a verified sending domain.

**Design rule:** the model chooses; code decides what is allowed. Tools receive business, caller, and conversation from the run, never from the model, and validate everything before writing.

## Compliance as product

- **A2P 10DLC:** carriers block unregistered business texting. The demo is registered as a sole-proprietor brand with one campaign. **In production, each tenant business is its own brand** — Fieldworx registers each customer as a software vendor (ISV), with days-to-weeks lead time per customer. Onboarding and the pilot pitch must account for this.
- **Retention:** demo data (conversations and everything created from them) is deleted within 30 days of the first message. Real tenants will get their own retention setting; a demo rule must never delete a paying shop's history.
- **Disclosure:** the demo persona ("Fieldworx HVAC & Mechanical") is fictional; every text carries the `Fieldworx Demo:` prefix, and bookings say no technician will come.

## Planned agent tools (v1, original list)

- `check_calendar` — owner availability
- `book_appointment` — calendar event + work order
- `get_pricing` — base rates for common jobs
- `check_service_area` — is this zip in territory?
- `lookup_customer` — phone match -> returning customer, past jobs, open work orders
- `lookup_units` — equipment on file
- `categorize_urgency` — emergency / same-day / routine
- `escalate_to_owner` — text owner a summary when beyond authority
- `create_work_order` — write to shared DB, tagged `source = agent_inbound`
- `update_work_order` — reschedules, cancellations, notes

---

## Product decisions already locked

- Trade-agnostic at the product layer. No HVAC-specific terms in codebase or UI.
- SMS-only at launch. Voice deferred to v2 (decide after 90 days of feedback).
- Multi-tenant from day one, never bolted on.
- Agent is a complete standalone product, not a teaser for EasyHVAC.
- Brand name deferred to near-launch. Working name: fieldworx-agent.

## Data / IP constraints

- NO real customer data from any source ports into this build. Fictional or anonymized seed only.
- No screenshots/demos/marketing use real customer names, addresses, dollar amounts, or job specifics.
- Approved marketing language: "battle-tested over 12 months in live commercial HVAC field operations." Never name the shop or owner.

---

## Business context (informs decisions, not code)

- Built as supplementary insurance income on evenings/weekends. Day job stays.
- Target: $3-5k MRR by end of December 2026 (~20-35 customers at $147/mo).
- Sustainable build over 12-18 months, not a panic sprint.
- Pricing: $147/mo standalone; $297-497/mo bundled with EasyHVAC later.
- Sales channel: phone calls, not email. Sell to whatever trades pick up first.
