/* eslint-disable @typescript-eslint/no-explicit-any */
// Customer-email caps (3 per number and 20 per business, per 24 h), with no
// network.
//
//   npm run test:email-cap
//
// EMAIL_MODE is fixed when the agent modules are first imported, so this file
// pins it to "send" in its own process (test:loop pins "log"). fetch is replaced
// with a stub that only answers api.resend.com and counts the calls: a capped
// email must leave the count unchanged, and nothing real is ever contacted. No
// .env file is loaded; the settings below are set in-process before any app
// code is imported.
import { FakeSupabase, seed } from "../eval/fakeSupabase";

// ------------------------------------------------------------------ test kit

type Fact = { name: string; ok: boolean; actual?: unknown };
let facts: Fact[] = [];
let casesPassed = 0;
let casesFailed = 0;
let factCount = 0;

function fact(name: string, ok: boolean, actual?: unknown) {
  facts.push({ name, ok, actual });
}
function same(name: string, actual: unknown, expected: unknown) {
  fact(name, JSON.stringify(actual) === JSON.stringify(expected), actual);
}

async function testCase(title: string, body: () => Promise<void>) {
  facts = [];
  try {
    await body();
  } catch (err) {
    fact(`the case threw: ${err instanceof Error ? err.message : String(err)}`, false);
  }
  const failures = facts.filter((f) => !f.ok);
  factCount += facts.length;
  if (failures.length === 0) {
    casesPassed++;
    console.log(`PASS  ${title}  (${facts.length} checks)`);
  } else {
    casesFailed++;
    console.log(`FAIL  ${title}  (${failures.length} of ${facts.length} checks failed)`);
    for (const f of failures) console.log(`        - ${f.name}  actual=${JSON.stringify(f.actual)}`);
  }
}

// ------------------------------------------------------------------ fixtures

const BIZ = "biz-demo";
const CONV = "conv-1";
const PHONE = "+15555550100";
const EMAIL = "pat@example.com";
const HOUR = 3_600_000;

function world() {
  const db = new FakeSupabase();
  seed(db, "conversations", {
    id: CONV,
    business_id: BIZ,
    lead_id: "lead-1",
    channel: "sms",
    customer_number: PHONE,
    business_number: "+15555550199",
    status: "active",
  });
  return db;
}

// Another number, with its own conversation.
function otherNumber(db: FakeSupabase, n: number): string {
  const conv = `conv-o${n}`;
  seed(db, "conversations", {
    id: conv,
    business_id: BIZ,
    lead_id: "lead-1",
    channel: "sms",
    customer_number: `+155555502${String(n).padStart(2, "0")}`,
    business_number: "+15555550199",
    status: "active",
  });
  return conv;
}

// `count` notifications rows for a conversation.
function seedMail(
  db: FakeSupabase,
  count: number,
  options: { conversation?: string; status?: string; audience?: string; ageMs?: number } = {},
) {
  for (let i = 0; i < count; i++) {
    seed(db, "notifications", {
      business_id: BIZ,
      conversation_id: options.conversation ?? CONV,
      audience: options.audience ?? "customer",
      recipient: EMAIL,
      template: "booking_customer",
      status: options.status ?? "sent",
      created_at: new Date(Date.now() - (options.ageMs ?? HOUR) - i * 1000).toISOString(),
    });
  }
}

// `total` sent customer emails spread over other numbers, at most 3 each (the
// per-number cap is not what is being tested).
function seedBusinessMail(db: FakeSupabase, total: number) {
  for (let n = 1, left = total; left > 0; n++, left -= 3) {
    seedMail(db, Math.min(3, left), { conversation: otherNumber(db, n) });
  }
}

const customerMail = (db: FakeSupabase) => db.tables.notifications.filter((n) => n.audience === "customer");

// ---------------------------------------------------------------------- main

async function main() {
  // Set before any app module is imported: config reads these once, on import.
  process.env.EMAIL_MODE = "send";
  process.env.RESEND_API_KEY = "test-key";
  process.env.OUTBOUND_MODE = "log";

  const resendCalls: { to: unknown }[] = [];
  let strayFetches = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (new URL(url).host !== "api.resend.com") {
      strayFetches++;
      throw new Error("network forbidden in test");
    }
    resendCalls.push({ to: JSON.parse(String(init?.body)).to });
    return new Response(JSON.stringify({ id: "re_test" }), { status: 200 });
  }) as typeof fetch;

  const { EMAIL_MODE, CUSTOMER_EMAIL_PER_NUMBER_DAY, CUSTOMER_EMAIL_PER_BUSINESS_DAY } = await import("../../src/lib/agent/config");
  const { sendEmail } = await import("../../src/lib/agent/notify");
  const { executeTool } = await import("../../src/lib/agent/tools");

  // Sends one email with the agent's own sendEmail; its log output is captured.
  async function send(db: FakeSupabase, audience: "customer" | "owner", extra: { conversationId?: string | null } = {}) {
    const lines: string[] = [];
    const original = { log: console.log, error: console.error, warn: console.warn };
    const capture = (...parts: unknown[]) => {
      lines.push(parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" "));
    };
    console.log = capture;
    console.error = capture;
    console.warn = capture;
    const before = resendCalls.length;
    try {
      const result = await sendEmail(db as never, {
        businessId: BIZ,
        conversationId: extra.conversationId === undefined ? CONV : extra.conversationId,
        leadId: null,
        appointmentId: null,
        audience,
        to: EMAIL,
        template: audience === "customer" ? "booking_customer" : "booking_owner",
        subject: "s",
        text: "t",
      });
      return { result, lines, delivered: resendCalls.length - before };
    } finally {
      console.log = original.log;
      console.error = original.error;
      console.warn = original.warn;
    }
  }
  const lastRow = (db: FakeSupabase) => db.tables.notifications.at(-1)!;
  const leaked = (lines: string[]) => [PHONE, EMAIL].filter((s) => lines.some((l) => l.includes(s)));

  await testCase("setup: send mode, caps 3 per number and 20 per business", async () => {
    same("EMAIL_MODE is send", EMAIL_MODE, "send");
    same("caps", [CUSTOMER_EMAIL_PER_NUMBER_DAY, CUSTOMER_EMAIL_PER_BUSINESS_DAY], [3, 20]);
  });

  await testCase("1   2 prior sent customer emails to this number -> the 3rd is sent", async () => {
    const db = world();
    seedMail(db, 2);
    const { result, delivered, lines } = await send(db, "customer");
    same("status sent, delivered once to the address", [result.status, delivered, resendCalls.at(-1)?.to], ["sent", 1, [EMAIL]]);
    same("the new row: sent, no error_code", [lastRow(db).status, lastRow(db).error_code], ["sent", null]);
    same("no cap log line", lines.filter((l) => l.includes("held back")), []);
  });

  await testCase("2   3 prior -> logged email_cap_number, fetch never called", async () => {
    const db = world();
    seedMail(db, 3);
    const { result, delivered, lines } = await send(db, "customer");
    same("status logged (what the agent sees), nothing delivered", [result.status, delivered], ["logged", 0]);
    same("the new row: logged, error_code email_cap_number, to the address", [lastRow(db).status, lastRow(db).error_code, lastRow(db).recipient], ["logged", "email_cap_number", EMAIL]);
    same("one fixed log line", lines, ["[notify] customer email held back: email_cap_number"]);
    same("no log line contains the phone number or the address", leaked(lines), []);
    const again = await send(db, "customer");
    same("a capped (logged) email does not count: still capped, still not delivered", [again.result.status, again.delivered, lastRow(db).error_code], ["logged", 0, "email_cap_number"]);
  });

  await testCase("3   only sent customer emails from the last 24 h to this number count", async () => {
    const db = world();
    seedMail(db, 3, { status: "logged" });
    seedMail(db, 3, { status: "failed" });
    seedMail(db, 3, { ageMs: 24 * HOUR + 60_000 });
    seedMail(db, 3, { audience: "owner" });
    seedMail(db, 3, { conversation: otherNumber(db, 1) });
    const { result, delivered } = await send(db, "customer");
    same("3 logged, 3 failed, 3 older than 24 h, 3 owner, 3 to another number: still sent", [result.status, delivered], ["sent", 1]);
  });

  await testCase("4   19 sent customer emails business-wide -> sends; 20 -> logged email_cap_business", async () => {
    const nineteen = world();
    seedBusinessMail(nineteen, 19);
    const sent = await send(nineteen, "customer");
    same("19: sent", [sent.result.status, sent.delivered], ["sent", 1]);

    const twenty = world();
    seedBusinessMail(twenty, 20);
    const { result, delivered } = await send(twenty, "customer");
    same("20: logged, nothing delivered", [result.status, delivered], ["logged", 0]);
    same("the new row: logged, error_code email_cap_business", [lastRow(twenty).status, lastRow(twenty).error_code], ["logged", "email_cap_business"]);
  });

  await testCase("5   the cap query fails -> logged email_cap_check_failed, fetch never called (fails closed)", async () => {
    const boom = { message: "boom", code: "XX000" };
    const variants: [string, (db: FakeSupabase) => void, string | null | undefined][] = [
      ["the conversation lookup fails", (db) => db.failNext("conversations", "select", boom), undefined],
      ["the notifications count fails", (db) => db.failNext("notifications", "select", boom), undefined],
      ["no conversation id to find the number by", () => {}, null],
    ];
    for (const [label, arrange, conversationId] of variants) {
      const db = world();
      arrange(db);
      const { result, delivered, lines } = await send(db, "customer", { conversationId });
      same(`${label}: logged, nothing delivered`, [result.status, delivered], ["logged", 0]);
      same(`${label}: the row says email_cap_check_failed`, [lastRow(db).status, lastRow(db).error_code], ["logged", "email_cap_check_failed"]);
      same(`${label}: no log line contains the phone number, the address or the DB error text`, [...leaked(lines), ...(lines.some((l) => l.includes("boom")) ? ["boom"] : [])], []);
    }
  });

  await testCase("6   the owner email is unaffected by both caps (and never runs the cap query)", async () => {
    const db = world();
    seedMail(db, 3); // this number is at its cap
    seedBusinessMail(db, 20); // and the business is at its cap
    db.failNext("notifications", "select", { message: "boom", code: "XX000" }); // a cap query would fail
    const owner = await send(db, "owner");
    same("owner email: sent and delivered", [owner.result.status, owner.delivered, lastRow(db).error_code], ["sent", 1, null]);
    same("the cap query was never issued for it: the queued failure is still waiting", db.takeForcedFailure("notifications", "select") !== null, true);
    const customer = await send(db, "customer");
    same("a customer email to the same number is capped", [customer.result.status, customer.delivered], ["logged", 0]);
  });

  // ---- through the tools: what the model is told ----

  const LEAD = "lead-1";
  const PROFILE = { display_name: "Dev Test Shop", is_demo: true, owner_email: "owner@example.com", service_zip_prefixes: ["750"] };
  // A lead and a conversation for PHONE; `consent` is the address the customer agreed to.
  function toolWorld(consent: string | null) {
    const db = new FakeSupabase();
    seed(db, "leads", { id: LEAD, business_id: BIZ, customer_id: null, work_order_id: null, urgency: null });
    seed(db, "conversations", {
      id: CONV,
      business_id: BIZ,
      lead_id: LEAD,
      channel: "sms",
      customer_number: PHONE,
      business_number: "+15555550199",
      status: "active",
      email_consent_address: consent,
      email_consent_at: consent ? new Date().toISOString() : null,
    });
    return db;
  }
  const toolContext = (db: FakeSupabase) => ({
    supabase: db as never,
    businessId: BIZ,
    conversationId: CONV,
    leadId: LEAD,
    customerNumber: PHONE,
    profile: PROFILE,
    now: new Date(),
  });
  const tool = async (db: FakeSupabase, name: string, input: Record<string, unknown>) => {
    const original = { log: console.log, error: console.error, warn: console.warn };
    console.log = console.error = console.warn = () => {};
    try {
      return await executeTool(name, input, toolContext(db));
    } finally {
      console.log = original.log;
      console.error = original.error;
      console.warn = original.warn;
    }
  };
  // The cap clears: the emails sent so far age out of the 24 h window.
  const ageOutSentMail = (db: FakeSupabase) => {
    for (const row of db.tables.notifications) {
      if (row.status === "sent") row.created_at = new Date(Date.now() - 25 * HOUR).toISOString();
    }
  };
  const SAVE = { name: "Pat Lee", email: EMAIL };

  await testCase("7   a capped confirmation -> not_sent_limit; once the cap clears, a later save sends it (not already_sent)", async () => {
    const db = toolWorld(null);
    seed(db, "appointments", {
      business_id: BIZ, lead_id: LEAD, customer_id: "c-1", conversation_id: CONV, kind: "phone_call",
      starts_at: new Date(Date.now() + 3 * 24 * HOUR).toISOString(), ends_at: new Date(Date.now() + 3 * 24 * HOUR + 1800_000).toISOString(),
    });
    seedMail(db, 3); // this number is at its cap
    const seeded = db.tables.notifications.length;
    const before = resendCalls.length;

    const first = await tool(db, "save_customer_details", SAVE);
    same("first save: confirmation_email not_sent_limit, none counted as sent", [first.result.confirmation_email, first.result.confirmations_sent], ["not_sent_limit", 0]);
    same("nothing was delivered", resendCalls.length - before, 0);
    same("the row: logged with error_code email_cap_number", db.tables.notifications.slice(seeded).map((n) => [n.status, n.error_code]), [["logged", "email_cap_number"]]);

    ageOutSentMail(db);
    const second = await tool(db, "save_customer_details", SAVE);
    same("cap cleared, second save: confirmation_email sent (the capped row is not 'already sent'), 1 counted", [second.result.confirmation_email, second.result.confirmations_sent], ["sent", 1]);
    same("delivered once, to the address", [resendCalls.length - before, resendCalls.at(-1)?.to], [1, [EMAIL]]);
    same("rows: the capped one stays logged, a new one is sent", db.tables.notifications.slice(seeded).map((n) => [n.status, n.error_code]), [["logged", "email_cap_number"], ["sent", null]]);

    const third = await tool(db, "save_customer_details", SAVE);
    same("third save: now it is already_sent, nothing more delivered", [third.result.confirmation_email, resendCalls.length - before], ["already_sent", 1]);
  });

  await testCase("7b  a cap check that cannot run is not a confirmation either", async () => {
    const db = toolWorld(null);
    seed(db, "appointments", {
      business_id: BIZ, lead_id: LEAD, customer_id: "c-1", conversation_id: CONV, kind: "phone_call",
      starts_at: new Date(Date.now() + 3 * 24 * HOUR).toISOString(), ends_at: new Date(Date.now() + 3 * 24 * HOUR + 1800_000).toISOString(),
    });
    db.tables.conversations[0].customer_number = null; // the cap cannot find the number
    const before = resendCalls.length;
    const first = await tool(db, "save_customer_details", SAVE);
    same("check failed: confirmation_email not_sent_limit, nothing delivered", [first.result.confirmation_email, resendCalls.length - before], ["not_sent_limit", 0]);
    same("the row says email_cap_check_failed", db.tables.notifications.map((n) => [n.status, n.error_code]), [["logged", "email_cap_check_failed"]]);
    db.tables.conversations[0].customer_number = PHONE;
    const second = await tool(db, "save_customer_details", SAVE);
    same("check works again: the next save sends (not already_sent)", [second.result.confirmation_email, resendCalls.length - before], ["sent", 1]);
  });

  await testCase("8   a capped booking email -> emails.customer not_sent_limit (not logged); a later save sends it", async () => {
    const db = toolWorld(EMAIL);
    await tool(db, "save_customer_details", { name: "Pat Lee" });
    const slots = (await tool(db, "get_available_slots", { kind: "phone_call" })).result.slots as { start: string }[];
    seedMail(db, 3); // this number is at its cap
    const seeded = db.tables.notifications.length;
    const before = resendCalls.length;

    const booked = await tool(db, "book_appointment", { kind: "phone_call", slot: slots[0].start, issue_summary: "Maintenance plan question" });
    same("booked, the owner was emailed, the customer's email was held back", [booked.result.booked, booked.result.emails], [true, { owner: "sent", customer: "not_sent_limit" }]);
    same("only the owner email was delivered", [resendCalls.length - before, resendCalls.at(-1)?.to], [1, ["owner@example.com"]]);
    same("the customer row: logged with error_code email_cap_number", db.tables.notifications.slice(seeded).filter((n) => n.audience === "customer").map((n) => [n.status, n.error_code]), [["logged", "email_cap_number"]]);

    ageOutSentMail(db);
    const later = await tool(db, "save_customer_details", SAVE);
    same("cap cleared, a later save: the booking confirmation is sent now (not already_sent)", [later.result.confirmation_email, later.result.confirmations_sent], ["sent", 1]);
  });

  // ---------------------------------------------------------------------------
  console.log("");
  const networkOk = strayFetches === 0;
  console.log(`${networkOk ? "PASS" : "FAIL"}  no real network calls (${resendCalls.length} stubbed Resend calls, ${strayFetches} stray fetches)`);
  console.log(
    `\nTotal: ${casesPassed + casesFailed} cases, ${casesPassed} passed, ${casesFailed} failed (${factCount} individual checks)`,
  );
  const ok = casesFailed === 0 && networkOk;
  console.log(ok ? "ALL PASS" : "SOME FAILED");
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.log("email-cap tests aborted:", err instanceof Error ? err.stack : String(err));
  process.exit(2);
});
