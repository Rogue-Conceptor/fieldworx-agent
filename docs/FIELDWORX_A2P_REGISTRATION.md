# Fieldworx Demo — A2P 10DLC Registration Package

> **Version:** v1.4
> **Last updated:** 2026-10-03 — brand APPROVED; Messaging Service created; campaign SUBMITTED, in review.
> **Versioning:** Bump when any field, page, or decision changes. After submission, log every rejection code and the fix here.

**What this file is:** Everything needed to register the Fieldworx demo number for US carrier texting, in submission order. Every field is written to pass review on the first try. Items in `[BRACKETS]` need your input before use.

---

## Changelog

- **v1.4** (2026-10-03) — Brand approved (OTP answered). Messaging Service "Fieldworx Demo" created: number in sender pool, defers to the number's own webhook, YES removed from opt-in keywords (START, UNSTOP remain). Campaign submitted. Changes from the package text at submission: opt-in method = Verbal (only option offered); opt-in message added (fixed confirmation, Section 4.5). New code commitment: rule 8 (opt-in confirmation on new conversations) — built and verified in commit eb7c458.
- **v1.3** (2026-10-03) — Brand submitted in the Fieldworx subaccount; status: in review. Twilio would not accept "Fieldworx Demo" as the brand name — Sole Proprietor brands default to the individual's legal name. No campaign changes needed: campaign text and pages already tie Fieldworx Demo to Jerry King (same pattern as Beacon's original approved sole-proprietor campaign). Messaging Service to be created during campaign registration.
- **v1.2** (2026-10-03) — Three pages published and verified by direct fetch: text matches v1.1, all NOINDEX, none in navigation. All campaign-field URLs changed from `https://jerrster.com/` to `https://www.jerrster.com/` to match the live pages exactly. Open item: site footer links to Beacon's policies on Fieldworx pages.
- **v1.1** (2026-10-03) — Filled in contact email (jerrykingglobal@gmail.com), effective date (October 3, 2026), and data retention (30 days). Inputs table and checklist updated.
- **v1.0** (2026-10-03) — Initial package: decisions, Twilio setup, brand fields, campaign fields (description, 7-element message flow, 3 samples, keyword replies), three web pages, interviewer invitation, playbook cross-check.

---

## 0. Locked decisions

| Decision | Choice |
|---|---|
| Twilio account | **Fieldworx subaccount** — fully separate from Beacon |
| Brand type | **Sole Proprietor — Jerry King** (Fieldworx is a personal project, not run by Beacon's EIN entity) |
| Number | **+1 972-619-7543** (already in the Fieldworx subaccount) |
| Brand name | **Jerry King** (Sole Proprietor default) |
| Program name | **Fieldworx Demo** |
| Message prefix | Every text starts **`Fieldworx Demo:`** |
| Persona | Inside the message, the assistant plays **Fieldworx HVAC & Mechanical**, a fictional company |
| Opt-in | **The user texts first.** The assistant never starts a conversation. |
| Number visibility | Shared privately with invited people. Web pages are unlisted and hidden from search engines. |
| Beacon's old sole-proprietor brand | **Leave it alone.** Revisit only if this brand is rejected for a mobile-number reason. |

---

## 1. Inputs needed from you before anything is submitted

| # | Input | Used in |
|---|---|---|
| 1 | **Contact email:** jerrykingglobal@gmail.com ✅ | All pages, HELP reply, message flow |
| 2 | **Effective date:** October 3, 2026 ✅ | Pages 2 and 3 |
| 3 | **Data retention:** 30 days ✅ | Privacy policy. **Build commitment:** the database must actually delete demo conversations older than 30 days. |
| 4 | Brand registration details: legal name, mailing address, email, **your mobile** (for the OTP) | Twilio brand form only — never on a public page |

---

## 2. Submission order

1. ~~Fill the three inputs~~ — done in v1.1
2. ~~Publish the three pages~~ — live and verified 2026-10-03 (`https://www.jerrster.com/fieldworx`, `/fieldworx/privacy`, `/fieldworx/terms`). Open: footer shows Beacon policy links — hide or relabel before submitting.
3. Fieldworx subaccount: confirm it's a paid (upgraded) account, not trial
4. ~~Create a **Messaging Service**~~ — done: "Fieldworx Demo", number attached, defers to sender's webhook, YES removed from opt-in keywords
5. Register the **Sole Proprietor brand** (Section 3) — answer the OTP text within 24 hours
6. Register the **campaign** (Section 4) against that brand and Messaging Service
7. Log the submission date here. Expect 1–3 weeks.
8. Meanwhile: build the agent loop. On approval, send one real test text to your own phone before inviting anyone.

---

## 3. Brand registration — Sole Proprietor

| Field | Value |
|---|---|
| Brand type | Sole Proprietor |
| First / last name | Jerry King |
| Brand name | **Jerry King** — Sole Proprietor brands default to the legal name; "Fieldworx Demo" was not accepted. The campaign and pages carry the program name. |
| Email | `jerrykingglobal@gmail.com` |
| Mobile (OTP) | your personal mobile |
| Address | your mailing address |
| Website | `https://www.jerrster.com/fieldworx` |
| Vertical | Technology |

---

## 4. Campaign registration

### 4.1 Campaign description

```
Fieldworx Demo is a technology demonstration of an AI text-message assistant for home-service businesses, built by software developer Jerry King. Invited users text the demo number first and receive conversational replies in which the assistant role-plays a fictional HVAC company, "Fieldworx HVAC & Mechanical." The company is fictional and provides no real services. Messages are sent only in reply to the user's own texts — no marketing, no promotions, and no unsolicited messages. Users consent by choosing to send the first text after receiving the consent notice.
```

### 4.2 Message flow / end-user consent — all 7 elements

```
[1-BRAND] Fieldworx Demo is a technology demonstration by Jerry King, a software developer, showing an AI-powered text-message assistant for home-service businesses. The assistant role-plays a fictional HVAC company, "Fieldworx HVAC & Mechanical," which does not provide real services.

[2-CONSENT METHOD] The demo phone number is not advertised publicly. It is shared directly with invited individuals (for example, prospective employers during interviews) by email or in person, always together with this notice: "Text this number to try the Fieldworx Demo AI assistant. By texting, you agree to receive automated replies to your messages. Message frequency varies. Msg & data rates may apply. Reply STOP to opt out, HELP for help. Privacy: https://www.jerrster.com/fieldworx/privacy Terms: https://www.jerrster.com/fieldworx/terms". Users opt in by sending the first text message themselves. The assistant never initiates a conversation and never texts anyone who has not texted it first.

[3-MESSAGE TYPES] Conversational customer-care replies that respond to the user's own messages: questions about the problem they describe, example appointment-time options, and safety guidance. No marketing or promotional content.

[4-FREQUENCY] Messages are sent only in reply to messages the user sends. Message frequency varies, typically 1 to 10 replies per conversation.

[5-DATA RATES] Message and data rates may apply.

[6-OPT-OUT] Reply STOP to opt out. Reply HELP for help. Contact: jerrykingglobal@gmail.com.

[7-POLICY LINKS + CONSENT EVIDENCE] The consent notice and how the number is shared are shown here: https://www.jerrster.com/fieldworx. Privacy Policy: https://www.jerrster.com/fieldworx/privacy. Terms of Service: https://www.jerrster.com/fieldworx/terms.
```

*Paste without the `[1-BRAND]`-style markers if the form looks cluttered — they're there so you can check all seven are present.*

### 4.3 Sample messages

Every sample starts with `Fieldworx Demo:` and ends with `Reply STOP to opt out.`

**Sample 1 — first reply**
```
Fieldworx Demo: Thanks for contacting Fieldworx HVAC & Mechanical! Sorry your AC is acting up. Is it not turning on at all, or running but not blowing cold air? Reply STOP to opt out.
```

**Sample 2 — scheduling**
```
Fieldworx Demo: Got it, a technician would need to take a look at that. For this demo I can offer Tuesday 2-4 PM or Wednesday 9-11 AM. Which works better for you? Reply STOP to opt out.
```

**Sample 3 — safety**
```
Fieldworx Demo: If you smell gas, leave the home now and call 911 or your gas utility from outside. Don't use light switches or appliances on the way out. Reply STOP to opt out.
```

### 4.4 Message content checkboxes

| Checkbox | Setting | Why |
|---|---|---|
| Embedded links | **Unchecked** | The assistant sends no links |
| Phone numbers | **Checked** | Safety replies reference 911 |
| Direct lending / loans | Unchecked | |
| Age-gated content | Unchecked | |

### 4.5 Keywords and replies

Opt-out management: **let Twilio manage it** (default).

| Type | Keywords | Reply |
|---|---|---|
| Opt-in | *(form field left blank, or `START` if required)* — any first text starts a conversation | **Opt-in message (submitted):** `Fieldworx Demo: Thanks for texting the Fieldworx Demo AI assistant. Msg frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to opt out.` Sent by code as the first message of every new conversation. **Opt-in method (submitted):** Verbal — the only option the form offered; the message flow explains the number is shared verbally or by email and the person texts first. |
| Opt-out | STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT | `Fieldworx Demo: You're unsubscribed and will get no further messages. Reply START to resubscribe.` |
| Help | HELP, INFO | `Fieldworx Demo: AI assistant demo by Jerry King. Not a real HVAC service. For emergencies, call 911. Contact: jerrykingglobal@gmail.com. Msg & data rates may apply. Reply STOP to opt out.` |

---

## 5. Agent rules that this registration commits us to

What we submit is a promise; the agent has to keep it. These go into the system prompt and the code.

| # | Rule | Enforced by |
|---|---|---|
| 1 | Every outbound text starts `Fieldworx Demo:` and ends `Reply STOP to opt out.` | Code, not the model — added after the model writes the reply |
| 2 | Never start a conversation; only reply to an inbound text | Code — the loop only runs on inbound |
| 3 | STOP / HELP / other opt-out keywords → the agent stays silent (Twilio answers) | Code — keyword check before calling the model |
| 4 | Gas smell, burning smell, smoke, carbon monoxide → safety reply first, nothing else | System prompt + code keyword backstop |
| 5 | No marketing, no promotions, no links | System prompt |
| 6 | Never claim to be a real company or promise a real technician | System prompt |
| 7 | Delete demo conversations after `30` days | Code — a scheduled cleanup (**NOT BUILT — blocker before sharing the number**) |
| 8 | First message of a new conversation is the exact registered opt-in confirmation | Code — built in commit eb7c458, verified live in log mode |

---

## 6. Web pages for jerrster.com (Squarespace)

**Squarespace settings for all three:** add as pages **not linked in navigation**, and in each page's SEO settings turn on **"Hide page from search engines."** Reviewers can still open them by URL; search engines won't list them.

Use these exact URL slugs: `/fieldworx`, `/fieldworx/privacy`, `/fieldworx/terms`. *(If Squarespace won't allow the nested slug, use `/fieldworx-privacy` and `/fieldworx-terms`, and update every URL in Section 4 to match before submitting.)*

### Page 1 — `/fieldworx` — Demo overview and consent evidence

```
FIELDWORX DEMO
An AI text-message assistant for home-service businesses

Fieldworx Demo is a technology demonstration built by Jerry King, a software developer. It shows how an AI assistant can answer a home-service company's text messages: understanding the customer's problem, asking useful questions, offering appointment options, and recognizing emergencies.

In this demo, the assistant role-plays a fictional company, "Fieldworx HVAC & Mechanical." The company is not real and provides no services. For any real emergency, call 911.

HOW PEOPLE GET ACCESS
The demo phone number is not advertised publicly. It is shared directly with invited individuals — for example, prospective employers during interviews — by email or in person. It is always shared together with this notice:

  "Text this number to try the Fieldworx Demo AI assistant. By texting, you agree to receive automated replies to your messages. Message frequency varies. Msg & data rates may apply. Reply STOP to opt out, HELP for help. Privacy: jerrster.com/fieldworx/privacy  Terms: jerrster.com/fieldworx/terms"

HOW CONSENT WORKS
You opt in by sending the first text yourself. The assistant never starts a conversation and never texts anyone who has not texted it first. Every reply begins with "Fieldworx Demo:" so you always know who is texting.

WHAT MESSAGES YOU'LL GET
Only replies to your own messages: questions about the problem you describe, example appointment times, and safety guidance. No marketing or promotional messages. Message frequency varies, typically 1 to 10 replies per conversation. Message and data rates may apply.

HOW TO STOP
Reply STOP at any time to opt out. You'll receive one confirmation and no further messages. Reply HELP for help.

Contact: jerrykingglobal@gmail.com
Privacy Policy: jerrster.com/fieldworx/privacy
Terms of Service: jerrster.com/fieldworx/terms
```

### Page 2 — `/fieldworx/privacy` — Privacy Policy

```
FIELDWORX DEMO — PRIVACY POLICY
Effective date: October 3, 2026

Fieldworx Demo is a technology demonstration operated by Jerry King. This policy explains what information the demo collects through text messages and how it is used.

INFORMATION WE COLLECT
When you text the Fieldworx Demo number, we collect your mobile phone number, the content of the messages you send, and the times they were sent. We do not ask for or require your name, address, email, or payment information. If you choose to include such details in a message, they are stored as part of that message.

HOW WE USE IT
Your information is used only to reply to your messages and to operate and demonstrate the assistant. Your message content is processed by an artificial intelligence model to generate replies.

SERVICE PROVIDERS
To operate the demo, information is processed by service providers acting on our behalf: Twilio (text message delivery), Anthropic (AI model that generates replies), and Supabase (secure data storage). They process information only to provide these services.

NO SHARING FOR MARKETING
No mobile information will be shared with third parties or affiliates for marketing or promotional purposes. Text messaging originator opt-in data and consent will not be shared with any third parties.

SMS MESSAGES
The demo sends text messages only in reply to messages you send. You consent by sending the first text after receiving the consent notice. Message frequency varies. Message and data rates may apply. Reply STOP to opt out. Reply HELP for help.

DATA RETENTION
Demo conversations are deleted within 30 days. You may request earlier deletion at any time by emailing jerrykingglobal@gmail.com from, or referencing, the phone number you used.

SECURITY
Data is stored with access controls that keep each business's records isolated. No system is perfectly secure, but we take reasonable measures to protect your information.

NOT A REAL SERVICE
"Fieldworx HVAC & Mechanical" is a fictional company used for demonstration only. In an emergency, call 911.

CHANGES
We may update this policy. Changes take effect when posted on this page.

CONTACT
Questions: jerrykingglobal@gmail.com
```

### Page 3 — `/fieldworx/terms` — Terms of Service

```
FIELDWORX DEMO — TERMS OF SERVICE
Effective date: October 3, 2026

WHAT THIS IS
Fieldworx Demo is a technology demonstration of an AI text-message assistant, operated by Jerry King. By texting the demo number, you agree to these terms.

NOT A REAL SERVICE
The assistant role-plays "Fieldworx HVAC & Mechanical," a fictional company. No technician will be dispatched, no appointment is real, and no information it provides is professional advice. Do not rely on it for any real repair, safety, or emergency decision. IN AN EMERGENCY, CALL 911.

AI-GENERATED REPLIES
Replies are generated automatically by an artificial intelligence model and may be inaccurate.

SMS COMMUNICATIONS
- Consent: You consent to receive text messages by sending the first message to the demo number after receiving the consent notice. The demo never texts anyone who has not texted it first.
- Message types: Conversational replies to your own messages only. No marketing or promotional messages.
- Frequency: Message frequency varies, typically 1 to 10 replies per conversation.
- Cost: Message and data rates may apply.
- Opt-out: Reply STOP at any time to stop receiving messages. You will receive one confirmation message.
- Help: Reply HELP for help, or email jerrykingglobal@gmail.com.
- Carriers are not liable for delayed or undelivered messages.

PRIVACY
See our Privacy Policy: jerrster.com/fieldworx/privacy

NO WARRANTY
The demo is provided "as is," without warranties of any kind, and may be changed or discontinued at any time.

CONTACT
jerrykingglobal@gmail.com
```

---

## 7. Invitation template — what you send interviewers

This is the consent notice in practice. Send it **exactly** this way every time — it's the evidence your message flow describes.

```
I built an AI text-message assistant for home-service businesses, and you can try it live.

Text (972) 619-7543 with something like "My AC isn't cooling, can you help?" The assistant plays a fictional HVAC company and will text you back.

By texting, you agree to receive automated replies to your messages. Message frequency varies. Msg & data rates may apply. Reply STOP to opt out, HELP for help.
Privacy: jerrster.com/fieldworx/privacy
Terms: jerrster.com/fieldworx/terms
```

---

## 8. Playbook cross-check

Every checklist item from the Beacon playbook, mapped to where this package satisfies it.

| Playbook item | Status | Where |
|---|---|---|
| Paid account, not trial | ☐ confirm | Section 2, step 3 |
| Number attached to a Messaging Service | ☐ do | Section 2, step 4 |
| Brand name matches what sends messages (Gotcha 1) | ✅ | "Fieldworx Demo" across brand, pages, prefix |
| Message flow has all 7 elements (Rejection 1) | ✅ | Section 4.2, each marked |
| Consent is provable / public evidence (Gotcha 3) | ✅ | Page 1 shows the exact notice and sharing method |
| SMS consent not bundled (Gotcha 4) | ✅ N/A | No app sign-up — consent is the user's own first text |
| "No mobile information will be shared…" (Gotcha 5) | ✅ | Page 2, word for word |
| "Message and data rates may apply" | ✅ | Pages 1–3, message flow, HELP reply |
| "Reply STOP to opt out" / "Reply HELP for help" | ✅ | Pages 1–3, every sample |
| Frequency disclosure | ✅ | Pages 1–3, message flow |
| What data is collected | ✅ | Page 2 |
| How users consent | ✅ | Pages 1–3 |
| Contact email | ✅ | jerrykingglobal@gmail.com |
| Terms has an SMS Communications section | ✅ | Page 3 |
| Every SMS starts with the program name | ✅ | `Fieldworx Demo:` — enforced in code (Section 5) |
| Every SMS ends with STOP language | ✅ | Enforced in code (Section 5) |
| Transactional, not marketing | ✅ | Conversational replies only |
| Twilio manages opt-out keywords (Gotcha 7) | ✅ | Section 4.5 — and the agent stays silent on STOP (Section 5) |
| Pages live before submitting | ✅ | Verified by fetch 2026-10-03 |

**Fieldworx-specific additions beyond the playbook:** AI processing and service providers disclosed in the privacy policy; "fictional company / call 911" on every page and in the HELP reply; data retention with a deletion commitment.

---

## 9. Submission log

| Date | Event | Result / code | Fix |
|---|---|---|---|
| 2026-10-03 | Brand submitted (Sole Proprietor, Jerry King) | In review | — |
| 2026-10-03 | Brand OTP answered | **Approved** | — |
| 2026-10-03 | Campaign submitted (Messaging Service: Fieldworx Demo) | In review | — |
