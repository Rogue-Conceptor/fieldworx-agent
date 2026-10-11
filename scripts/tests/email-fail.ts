/* eslint-disable @typescript-eslint/no-explicit-any */
// Delivery-failure test for the confirmation email, with no network.
//
//   npm run test:email-fail
//
// EMAIL_MODE is fixed when the agent modules are first imported, and test:loop
// pins it to "log", where delivery cannot fail. This file pins it to "send"
// with an empty RESEND_API_KEY instead: deliver() then returns "failed" with
// missing_api_key before it would ever call fetch. fetch is replaced with a
// function that throws, and the test asserts it was never called. No .env file
// is loaded (the npm script has no --env-file), and the settings below are set
// in-process before any app code is imported.
import { FakeSupabase, seed, type Row } from "../eval/fakeSupabase";

type ProcessInbound = (typeof import("../../src/lib/agent/run"))["processInbound"];
type InboundArgs = Parameters<ProcessInbound>[0];

// ---------------------------------------------------------------- fake model

type Snapshot = { messages: any[] };
type Step = (snap: Snapshot) => any;
type PlannedCall = { name: string; input: any } | ((snap: Snapshot) => { name: string; input: any });

let toolSequence = 0;
const usage = () => ({ input_tokens: 100, output_tokens: 20 });

class FakeAnthropic {
  calls: Snapshot[] = [];
  constructor(private script: Step[]) {}
  messages = {
    create: async (params: any) => {
      const snap: Snapshot = structuredClone({ messages: params.messages });
      this.calls.push(snap);
      const step = this.script[this.calls.length - 1];
      if (!step) throw new Error("fake model script exhausted");
      return step(snap);
    },
  };
}

const toolStep =
  (...calls: PlannedCall[]): Step =>
  (snap) => ({
    id: "msg_fake",
    type: "message",
    role: "assistant",
    model: "fake",
    stop_reason: "tool_use",
    usage: usage(),
    content: [
      { type: "thinking", thinking: "planning the next step", signature: `sig-${toolSequence + 1}` },
      ...calls.map((call) => {
        const { name, input } = typeof call === "function" ? call(snap) : call;
        return { type: "tool_use", id: `toolu_${++toolSequence}`, name, input };
      }),
    ],
  });

const textStep =
  (text: string): Step =>
  () => ({
    id: "msg_fake",
    type: "message",
    role: "assistant",
    model: "fake",
    stop_reason: "end_turn",
    usage: usage(),
    content: [
      { type: "thinking", thinking: "wrapping up", signature: "sig-final" },
      { type: "text", text },
    ],
  });

function firstOfferedSlot(snap: Snapshot): { start: string; label: string } {
  for (const message of [...snap.messages].reverse()) {
    if (message.role !== "user" || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type !== "tool_result") continue;
      const result = JSON.parse(block.content);
      if (Array.isArray(result.slots) && result.slots.length > 0) return result.slots[0];
    }
  }
  throw new Error("no slots in the transcript");
}

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
const LEAD = "lead-1";
const CONV = "conv-1";
const INBOUND = "inb-1";
const PHONE = "+15555550100";
const BUSINESS_NUMBER = "+15555550199";
const EMAIL = "pat@example.com";

function world() {
  const db = new FakeSupabase();
  seed(db, "businesses", {
    id: BIZ,
    agent_profile: {
      display_name: "Dev Test Shop",
      trade: "HVAC",
      is_demo: true,
      program_prefix: "Dev Test Shop:",
      owner_email: "owner@example.com",
      service_zip_prefixes: ["750", "751"],
      service_area: "Dallas area",
      hours: "Mon-Fri 8 AM-5 PM Central",
    },
  });
  seed(db, "leads", { id: LEAD, business_id: BIZ, customer_id: null, work_order_id: null, urgency: null });
  seed(db, "conversations", {
    id: CONV,
    business_id: BIZ,
    lead_id: LEAD,
    channel: "sms",
    customer_number: PHONE,
    business_number: BUSINESS_NUMBER,
    status: "active",
    email_consent_address: null,
    email_consent_at: null,
  });
  seed(db, "messages", {
    id: INBOUND,
    business_id: BIZ,
    conversation_id: CONV,
    direction: "inbound",
    body: "My AC stopped cooling",
  });
  const args: InboundArgs = {
    businessId: BIZ,
    conversationId: CONV,
    inboundMessageId: INBOUND,
    leadId: LEAD,
    customerNumber: PHONE,
    businessNumber: BUSINESS_NUMBER,
    inboundBody: "My AC stopped cooling",
    conversationIsNew: false,
    receivedAt: Date.now(),
  };
  return { db, args };
}

const save = (extra: Record<string, unknown> = {}): PlannedCall => ({
  name: "save_customer_details",
  input: { name: "Pat Lee", street_address: "1 Main St", zip: "75043", ...extra },
});
const checkArea: PlannedCall = { name: "check_service_area", input: { zip: "75043" } };
const getSlots: PlannedCall = { name: "get_available_slots", input: { kind: "service_visit" } };
const book: PlannedCall = (snap) => ({
  name: "book_appointment",
  input: { kind: "service_visit", slot: firstOfferedSlot(snap).start, issue_summary: "AC not cooling" },
});
const resultOf = (agentRun: Row, index: number) => JSON.parse(agentRun.tool_calls[index].result);
const customerMail = (db: FakeSupabase) => db.tables.notifications.filter((n) => n.audience === "customer");
const consentWrites = (db: FakeSupabase) =>
  db.log.filter((l) => l.table === "conversations" && l.op === "update" && "email_consent_address" in (l.payload ?? {}));

// ---------------------------------------------------------------------- main

async function main() {
  // Set before any app module is imported: config reads these once, on import.
  process.env.EMAIL_MODE = "send";
  process.env.RESEND_API_KEY = "";
  process.env.OUTBOUND_MODE = "log";

  let fetchCalls = 0;
  globalThis.fetch = (() => {
    fetchCalls++;
    throw new Error("network forbidden in test");
  }) as typeof fetch;

  const { EMAIL_MODE } = await import("../../src/lib/agent/config");
  const { processInbound } = await import("../../src/lib/agent/run");

  async function run(db: FakeSupabase, args: InboundArgs, script: Step[]) {
    const model = new FakeAnthropic(script);
    const lines: string[] = [];
    const original = { log: console.log, error: console.error, warn: console.warn };
    const capture = (...parts: unknown[]) => {
      lines.push(parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" "));
    };
    console.log = capture;
    console.error = capture;
    console.warn = capture;
    try {
      await processInbound(args, { supabase: db as never, anthropic: model as never });
    } finally {
      console.log = original.log;
      console.error = original.error;
      console.warn = original.warn;
    }
    return { model, lines };
  }

  await testCase("setup: the agent really is in send mode, so a delivery can fail", async () => {
    same("EMAIL_MODE is send", EMAIL_MODE, "send");
    same("RESEND_API_KEY is empty", process.env.RESEND_API_KEY, "");
  });

  await testCase("1   confirmation fails -> failed; consent stays recorded; a later save tries again", async () => {
    const { db, args } = world();
    const { lines } = await run(db, args, [
      toolStep(save()),
      toolStep(checkArea),
      toolStep(getSlots),
      toolStep(book),
      // one round (the loop allows five), run in order
      toolStep(save({ email: EMAIL }), save({ email: EMAIL })),
      textStep("Done."),
    ]);
    const t = db.tables;
    const run0 = t.agent_runs[0];
    same("the booking itself succeeded (owner email failing does not fail it)", [t.appointments.length, resultOf(run0, 3).booked], [1, true]);
    same("book result: owner failed, customer no_consent", resultOf(run0, 3).emails, { owner: "failed", customer: "no_consent" });

    const first = resultOf(run0, 4);
    same("first email save: the save worked, confirmation_email failed, none counted as sent", [first.saved, first.confirmation_email, first.confirmations_sent], [true, "failed", 0]);
    same("one customer notification row: failed, missing_api_key, to that address", customerMail(db).slice(0, 1).map((n) => [n.status, n.error_code, n.recipient]), [["failed", "missing_api_key", EMAIL]]);
    fact("consent was not rolled back: address and time still set", t.conversations[0].email_consent_address === EMAIL && !Number.isNaN(Date.parse(t.conversations[0].email_consent_at)), t.conversations[0]);
    same("customer row keeps the email", t.customers[0].email, EMAIL);

    const second = resultOf(run0, 5);
    same("later save with the same email: tried again, failed again", [second.saved, second.confirmation_email, second.confirmations_sent], [true, "failed", 0]);
    same("a failed send is not treated as confirmed: a second failed notification row", customerMail(db).map((n) => [n.status, n.appointment_id]), [["failed", t.appointments[0].id], ["failed", t.appointments[0].id]]);
    same("consent was written once, not renewed by the retry", consentWrites(db).length, 1);
    same("no log line contains the name, address, email or phone number", ["Pat Lee", "Main St", EMAIL, PHONE].filter((s) => lines.some((l) => l.includes(s))), []);
  });

  await testCase("2   consent recorded first, then a booking whose email fails -> the booking stands", async () => {
    const { db, args } = world();
    await run(db, args, [
      toolStep(save({ email: EMAIL })),
      toolStep(checkArea),
      toolStep(getSlots),
      toolStep(book),
      textStep("You're booked."),
    ]);
    const t = db.tables;
    same("save result before any booking: no_bookings", resultOf(t.agent_runs[0], 0).confirmation_email, "no_bookings");
    same("book result: both emails failed, booked true", [resultOf(t.agent_runs[0], 3).booked, resultOf(t.agent_runs[0], 3).emails], [true, { owner: "failed", customer: "failed" }]);
    same("1 appointment, 1 work order, lead booked", [t.appointments.length, t.work_orders.length, t.leads[0].status], [1, 1, "booked"]);
    same("the customer notification is recorded as failed", customerMail(db).map((n) => [n.status, n.recipient]), [["failed", EMAIL]]);
  });

  // ---------------------------------------------------------------------------
  console.log("");
  const networkOk = fetchCalls === 0;
  console.log(`${networkOk ? "PASS" : "FAIL"}  no network calls (fetch was invoked ${fetchCalls} times)`);
  console.log(
    `\nTotal: ${casesPassed + casesFailed} cases, ${casesPassed} passed, ${casesFailed} failed (${factCount} individual checks)`,
  );
  const ok = casesFailed === 0 && networkOk;
  console.log(ok ? "ALL PASS" : "SOME FAILED");
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.log("email-fail tests aborted:", err instanceof Error ? err.stack : String(err));
  process.exit(2);
});
