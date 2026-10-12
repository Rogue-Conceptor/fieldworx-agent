/* eslint-disable @typescript-eslint/no-explicit-any */
// Permanent no-network tests for the agent's tool loop (processInbound): a fake
// database and a scripted fake model stand in for Supabase and Anthropic.
//
//   npm run test:loop
//
// Plain checks, PASS/FAIL per case, a total, exit code 1 on any failure.
import { FakeSupabase, seed, type Row } from "../eval/fakeSupabase";

type ProcessInbound = (typeof import("../../src/lib/agent/run"))["processInbound"];
type InboundArgs = Parameters<ProcessInbound>[0];

// ---------------------------------------------------------------- fake model

type Snapshot = { messages: any[]; system: string; tools: any[]; thinking: any };
type Step = (snap: Snapshot) => any;
type PlannedCall = { name: string; input: any } | ((snap: Snapshot) => { name: string; input: any });

let toolSequence = 0;
const usage = () => ({ input_tokens: 100, output_tokens: 20 });

// Returns scripted responses in order and records what it was asked: each call's
// messages (copied at call time, because the agent keeps appending to the same
// array), the options passed as the second argument, and when it was called.
class FakeAnthropic {
  calls: Snapshot[] = [];
  options: any[] = [];
  calledAt: number[] = [];
  responses: any[] = [];

  constructor(private script: Step[]) {}

  messages = {
    create: async (params: any, options?: any) => {
      this.calledAt.push(Date.now());
      this.options.push(options === undefined ? undefined : structuredClone(options));
      const snap: Snapshot = structuredClone({
        messages: params.messages,
        system: params.system,
        tools: params.tools,
        thinking: params.thinking,
      });
      this.calls.push(snap);
      const step = this.script[this.calls.length - 1];
      if (!step) throw new Error("fake model script exhausted");
      const response = step(snap);
      this.responses.push(structuredClone(response));
      return response;
    },
  };
}

// A model turn that calls tools. A thinking block comes first, as with the real
// model, so the loop's "replay the turn unmodified" rule is exercised.
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

const throwStep =
  (error: Error): Step =>
  () => {
    throw error;
  };

// The first slot from the most recent get_available_slots result in the
// transcript, so a scripted booking uses a time the tool really offered.
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

// ------------------------------------------------------------- fake sending

type SendArgs = { to: string; from: string; body: string };

// Stands in for sendOutbound: records every text it is asked to send, and
// `failWith(callNumber)` (1-based) may return an error to throw instead.
type Sender = {
  calls: SendArgs[];
  send: (args: SendArgs) => Promise<{ sid: string | null; sent: boolean }>;
};
function fakeSender(failWith?: (callNumber: number) => Error | null): Sender {
  const calls: SendArgs[] = [];
  return {
    calls,
    send: async (args) => {
      calls.push(args);
      const error = failWith?.(calls.length);
      if (error) throw error;
      return { sid: null, sent: false };
    },
  };
}

// What the Twilio SDK throws on a failed send: an HTTP status and a numeric code.
class RestException extends Error {
  constructor(
    readonly status: number,
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}
const twilioOptedOut = () => new RestException(400, 21610, "[HTTP 400] Unable to create record: Attempt to send to unsubscribed recipient");

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
const PREFIX = "Dev Test Shop:";

function world(options: { profile?: Record<string, unknown>; newerInbound?: boolean; receivedAgoMs?: number } = {}) {
  const db = new FakeSupabase();
  const profile = {
    display_name: "Dev Test Shop",
    trade: "HVAC",
    is_demo: true,
    program_prefix: PREFIX,
    owner_email: "owner@example.com",
    service_zip_prefixes: ["750", "751"],
    service_area: "Dallas area",
    hours: "Mon-Fri 8 AM-5 PM Central",
    ...options.profile,
  };
  seed(db, "businesses", { id: BIZ, agent_profile: profile });
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
  if (options.newerInbound) {
    seed(db, "messages", {
      id: "inb-2",
      business_id: BIZ,
      conversation_id: CONV,
      direction: "inbound",
      body: "hello? anyone there?",
    });
  }
  const args: InboundArgs = {
    businessId: BIZ,
    conversationId: CONV,
    inboundMessageId: INBOUND,
    leadId: LEAD,
    customerNumber: PHONE,
    businessNumber: BUSINESS_NUMBER,
    inboundBody: "My AC stopped cooling",
    conversationIsNew: false,
    receivedAt: Date.now() - (options.receivedAgoMs ?? 0),
  };
  return { db, args };
}

const save = (extra: Record<string, unknown> = {}): PlannedCall => ({
  name: "save_customer_details",
  input: { name: "Pat Lee", street_address: "1 Main St", zip: "75043", ...extra },
});
const checkArea = (zip = "75043"): PlannedCall => ({ name: "check_service_area", input: { zip } });
const getSlots = (kind = "service_visit"): PlannedCall => ({ name: "get_available_slots", input: { kind } });
// book_appointment takes the slot as a label or an ISO start; these cases pass the ISO start.
const book =
  (slotStart?: string): PlannedCall =>
  (snap) => ({
    name: "book_appointment",
    input: { kind: "service_visit", slot: slotStart ?? firstOfferedSlot(snap).start, issue_summary: "AC not cooling" },
  });
const resultOf = (agentRun: Row, index: number) => JSON.parse(agentRun.tool_calls[index].result);

// A customer already on record for PHONE, as an earlier conversation left it.
// `linked` ties it to this test's lead, as save_customer_details would have.
function seedCustomer(
  db: FakeSupabase,
  options: { name: string; email: string | null; address?: string; linked?: boolean },
): Row {
  const customer = seed(db, "customers", {
    business_id: BIZ,
    name: options.name,
    phone: PHONE,
    email: options.email,
    source: "agent_inbound",
  });
  if (options.address) {
    seed(db, "service_locations", { business_id: BIZ, customer_id: customer.id, address: options.address });
  }
  if (options.linked) db.tables.leads.find((l) => l.id === LEAD)!.customer_id = customer.id;
  return customer;
}
const customerMail = (db: FakeSupabase) => db.tables.notifications.filter((n) => n.audience === "customer");
const consentWrites = (db: FakeSupabase) =>
  db.log.filter((l) => l.table === "conversations" && l.op === "update" && "email_consent_address" in (l.payload ?? {}));

// ---------------------------------------------------------------------- main

async function main() {
  // The agent modules read these two settings when they are first imported.
  process.env.EMAIL_MODE = "log";
  process.env.OUTBOUND_MODE = "log";

  let fetchCalls = 0;
  globalThis.fetch = (() => {
    fetchCalls++;
    throw new Error("loop tests must not use the network");
  }) as typeof fetch;

  const { processInbound } = await import("../../src/lib/agent/run");
  const { buildSlots } = await import("../../src/lib/agent/clock");
  const { CLAUDE_TIMEOUT_MS, RUN_DEADLINE_MS } = await import("../../src/lib/agent/config");
  const { FALLBACK_TEXT } = await import("../../src/lib/agent/keywords");
  const { formatOutbound } = await import("../../src/lib/agent/format");

  // Runs one inbound message through the agent with the fake model; the agent's
  // own console output is captured so it can be inspected instead of printed.
  // `send` stands in for the Twilio send (log mode never throws); left out, the
  // agent's own sendOutbound runs.
  async function run(db: FakeSupabase, args: InboundArgs, script: Step[], send?: Sender["send"]) {
    const model = new FakeAnthropic(script);
    const lines: string[] = [];
    const events: unknown[] = [];
    const original = { log: console.log, error: console.error, warn: console.warn };
    const capture = (...parts: unknown[]) => {
      lines.push(parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" "));
    };
    console.log = capture;
    console.error = capture;
    console.warn = capture;
    try {
      await processInbound(args, {
        supabase: db as never,
        anthropic: model as never,
        send,
        onEvent: (e) => events.push(e),
      });
    } finally {
      console.log = original.log;
      console.error = original.error;
      console.warn = original.warn;
    }
    return { model, lines, events };
  }

  // timeout = min(CLAUDE_TIMEOUT_MS, remaining - 2000), within 50 ms, plus the retry count.
  function optionChecks(label: string, model: FakeAnthropic, receivedAt: number, expectedRetries: number) {
    model.options.forEach((o, i) => {
      const remainingAtCall = RUN_DEADLINE_MS - (model.calledAt[i] - receivedAt);
      const expected = Math.min(CLAUDE_TIMEOUT_MS, remainingAtCall - 2000);
      fact(
        `${label}, call ${i + 1}: timeout ${o?.timeout} vs expected ${Math.round(expected)} (remaining at call ${Math.round(remainingAtCall)} ms)`,
        typeof o?.timeout === "number" && Math.abs(o.timeout - expected) <= 50,
        o,
      );
      same(`${label}, call ${i + 1}: maxRetries`, o?.maxRetries, expectedRetries);
      same(`${label}, call ${i + 1}: option keys`, Object.keys(o ?? {}).sort(), ["maxRetries", "timeout"]);
    });
  }

  const outbound = (db: FakeSupabase) => db.tables.messages.filter((m) => m.direction === "outbound");
  const leadUpdates = (db: FakeSupabase) => db.log.filter((l) => l.table === "leads" && l.op === "update");

  await testCase("1   happy booking (email saved)", async () => {
    const { db, args } = world();
    const { model, lines } = await run(db, args, [
      toolStep(save({ email: "pat@example.com" })),
      toolStep(checkArea()),
      toolStep(getSlots()),
      toolStep(book()),
      textStep("You're all set for Monday morning. Anything else?"),
    ]);
    const t = db.tables;
    const appointment = t.appointments[0];
    const workOrder = t.work_orders[0];
    const customer = t.customers[0];
    const location = t.service_locations[0];
    const lead = t.leads[0];
    const agentRun = t.agent_runs[0];
    const replies = outbound(db);
    same("model called 5 times", model.calls.length, 5);
    same("1 appointment", t.appointments.length, 1);
    fact("appointment: service_visit, scheduled, lead/customer/conversation set", appointment?.kind === "service_visit" && appointment.status === "scheduled" && appointment.lead_id === LEAD && appointment.customer_id === customer?.id && appointment.conversation_id === CONV, appointment);
    same("1 work order", t.work_orders.length, 1);
    fact("work order: service/scheduled, lead + location + customer set, scheduled_at = appointment start", workOrder?.type === "service" && workOrder.status === "scheduled" && workOrder.lead_id === LEAD && workOrder.service_location_id === location?.id && workOrder.customer_id === customer?.id && Date.parse(workOrder.scheduled_at) === Date.parse(appointment.starts_at), workOrder);
    fact("appointment.work_order_id = work order id", appointment?.work_order_id === workOrder?.id, appointment?.work_order_id);
    fact("lead: status booked, work_order_id and customer_id linked", lead.status === "booked" && lead.work_order_id === workOrder?.id && lead.customer_id === customer?.id, lead);
    fact("customer saved with phone, name, email; location '1 Main St, 75043'", customer?.phone === PHONE && customer.name === "Pat Lee" && customer.email === "pat@example.com" && location?.address === "1 Main St, 75043", { customer, location });
    same("2 notifications", t.notifications.length, 2);
    fact("owner notification: logged, booking_owner, owner@example.com, linked to the appointment", t.notifications[0]?.audience === "owner" && t.notifications[0].status === "logged" && t.notifications[0].template === "booking_owner" && t.notifications[0].recipient === "owner@example.com" && t.notifications[0].appointment_id === appointment?.id, t.notifications[0]);
    fact("customer notification: logged, booking_customer, pat@example.com", t.notifications[1]?.audience === "customer" && t.notifications[1].status === "logged" && t.notifications[1].template === "booking_customer" && t.notifications[1].recipient === "pat@example.com", t.notifications[1]);
    fact("consent recorded on the conversation: the address, with a timestamp", t.conversations[0].email_consent_address === "pat@example.com" && !Number.isNaN(Date.parse(t.conversations[0].email_consent_at)), t.conversations[0]);
    same("save result before any booking: confirmation_email no_bookings, none sent", [resultOf(agentRun, 0).confirmation_email, resultOf(agentRun, 0).confirmations_sent], ["no_bookings", 0]);
    same("book result: customer email is logged", resultOf(agentRun, 3).emails, { owner: "logged", customer: "logged" });
    same("1 agent_runs row", t.agent_runs.length, 1);
    same("agent_runs outcome replied", agentRun?.outcome, "replied");
    same("agent_runs tool_calls: 4, in order, all ok", agentRun?.tool_calls.map((c: any) => `${c.name}:${c.ok}`), ["save_customer_details:true", "check_service_area:true", "get_available_slots:true", "book_appointment:true"]);
    same("agent_runs error_code null", agentRun?.error_code, null);
    same("1 outbound reply stored", replies.length, 1);
    fact("reply: prefixed, carries the model's text, STOP line, linked from the run", replies[0]?.body.startsWith(PREFIX) && replies[0].body.includes("You're all set for Monday morning.") && replies[0].body.endsWith("Reply STOP to opt out.") && agentRun?.outbound_message_id === replies[0].id, replies[0]?.body);
    fact("first call: 5 tools, adaptive thinking, empty on-file text in the system prompt", model.calls[0].tools.length === 5 && model.calls[0].thinking?.type === "adaptive" && model.calls[0].system.includes("- Nothing on file yet."), { tools: model.calls[0].tools.length, thinking: model.calls[0].thinking });
    const replayed = model.calls[1].messages.at(-2);
    fact("assistant turn replayed unmodified (thinking block included)", replayed?.role === "assistant" && JSON.stringify(replayed.content) === JSON.stringify(model.responses[0].content), replayed);
    const toolResults = model.calls[1].messages.at(-1);
    fact("one user message with one tool_result per tool_use", toolResults?.role === "user" && toolResults.content.length === 1 && toolResults.content[0].type === "tool_result" && toolResults.content[0].tool_use_id === model.responses[0].content[1].id && toolResults.content[0].is_error === false, toolResults);
    const leaked = ["Pat Lee", "1 Main St", "pat@example.com", "owner@example.com", PHONE].filter((s) => lines.some((l) => l.includes(s)));
    same("no log line contains the name, address, emails or phone number", leaked, []);
    fact("run log lists tool names and ok flags", lines.some((l) => l.includes("book_appointment") && l.includes('"ok":true')), lines);
  });

  await testCase("1b  happy booking, no email saved", async () => {
    const { db, args } = world();
    await run(db, args, [toolStep(save()), toolStep(checkArea()), toolStep(getSlots()), toolStep(book()), textStep("Booked. See you then.")]);
    const t = db.tables;
    same("1 appointment, 1 work order", [t.appointments.length, t.work_orders.length], [1, 1]);
    same("exactly 1 notification (owner, logged)", t.notifications.map((n) => `${n.audience}:${n.status}`), ["owner:logged"]);
    same("book result: customer email is no_consent", resultOf(t.agent_runs[0], 3).emails, { owner: "logged", customer: "no_consent" });
  });

  await testCase("2   work order insert fails (compensating delete)", async () => {
    const { db, args } = world();
    db.failNext("work_orders", "insert", { message: "boom", code: "XX000" });
    await run(db, args, [toolStep(save()), toolStep(getSlots()), toolStep(book()), textStep("Sorry, let me try that again.")]);
    const t = db.tables;
    const bookCall = t.agent_runs[0].tool_calls[2];
    fact("book_appointment ok false, wrote false, 'Booking failed; please try again.'", bookCall.ok === false && bookCall.wrote === false && JSON.parse(bookCall.result).error === "Booking failed; please try again.", bookCall);
    same("appointments: insert, then delete", db.log.filter((l) => l.table === "appointments").map((l) => `${l.op}:${l.error}`), ["insert:null", "delete:null"]);
    same("no appointment left", t.appointments.length, 0);
    same("no work order left", t.work_orders.length, 0);
    same("no notifications", t.notifications.length, 0);
    fact("lead not booked, no work order link", t.leads[0].status !== "booked" && !t.leads[0].work_order_id, t.leads[0]);
  });

  await testCase("3   double booking (slot taken by another lead)", async () => {
    const { db, args } = world();
    const target = buildSlots("service_visit", new Date())[0];
    seed(db, "appointments", { business_id: BIZ, lead_id: "other-lead", customer_id: "other-cust", kind: "service_visit", starts_at: target.start, ends_at: target.end });
    await run(db, args, [toolStep(save()), toolStep(book(target.start)), textStep("That one is taken; here are other times.")]);
    const t = db.tables;
    const bookCall = t.agent_runs[0].tool_calls[1];
    fact("book_appointment ok false with the 'isn't available' message", bookCall.ok === false && JSON.parse(bookCall.result).error === "That time isn't available. Call get_available_slots for current openings.", bookCall);
    same("no appointment insert attempted", db.log.filter((l) => l.table === "appointments" && l.op === "insert").length, 0);
    same("only the other lead's appointment exists", t.appointments.map((a) => a.lead_id), ["other-lead"]);
    same("no work order", t.work_orders.length, 0);
  });

  await testCase("4   race (slot looks free, insert hits 23505)", async () => {
    const { db, args } = world();
    db.beforeNextInsert("appointments", (input) => {
      seed(db, "appointments", { business_id: BIZ, lead_id: "racer", customer_id: "racer-cust", kind: input.kind, starts_at: input.starts_at, ends_at: input.ends_at });
    });
    await run(db, args, [toolStep(save()), toolStep(getSlots()), toolStep(book()), textStep("Someone just took that one.")]);
    const t = db.tables;
    const bookCall = t.agent_runs[0].tool_calls[2];
    fact("book_appointment ok false, 'That slot was just taken…'", bookCall.ok === false && JSON.parse(bookCall.result).error === "That slot was just taken. Call get_available_slots again.", bookCall);
    same("one appointment insert attempt, rejected with 23505", db.log.filter((l) => l.table === "appointments" && l.op === "insert").map((l) => l.error), ["23505"]);
    same("only the racer's appointment exists", t.appointments.map((a) => a.lead_id), ["racer"]);
    same("no work order created", t.work_orders.length, 0);
  });

  await testCase("5   booked, then the model fails", async () => {
    const { db, args } = world();
    await run(db, args, [toolStep(save()), toolStep(checkArea()), toolStep(getSlots()), toolStep(book()), throwStep(new Error("connection reset"))]);
    const t = db.tables;
    const replies = outbound(db);
    const agentRun = t.agent_runs[0];
    same("appointment and work order exist", [t.appointments.length, t.work_orders.length], [1, 1]);
    same("1 outbound reply", replies.length, 1);
    fact("reply is the code-built confirmation with the demo sentence", /^Dev Test Shop: You're booked for a service visit, (Mon|Tue|Wed|Thu|Fri) [A-Z][a-z]{2} \d{1,2}, (9-11 AM|1-3 PM)\. This is a demo booking, so no technician will actually come\. Reply STOP to opt out\.$/.test(replies[0]?.body ?? ""), replies[0]?.body);
    fact("reply is not the generic fallback", !(replies[0]?.body ?? "").includes(FALLBACK_TEXT), replies[0]?.body);
    same("lead stays booked", t.leads[0].status, "booked");
    same("no lead update set escalated", leadUpdates(db).filter((l) => l.payload?.status === "escalated").length, 0);
    same("agent_runs outcome replied", agentRun.outcome, "replied");
    same("agent_runs error_code keeps the failure", agentRun.error_code, "connection reset");
    same("agent_runs tool_calls: 4", agentRun.tool_calls.length, 4);
  });

  await testCase("6   superseded after a write", async () => {
    const { db, args } = world({ newerInbound: true });
    await run(db, args, [toolStep({ name: "save_customer_details", input: { name: "Pat Lee" } }), textStep("Thanks Pat, got your name.")]);
    const t = db.tables;
    same("the tool wrote (ok and wrote)", [t.agent_runs[0].tool_calls[0].ok, t.agent_runs[0].tool_calls[0].wrote], [true, true]);
    same("reply still sent (1 outbound)", outbound(db).length, 1);
    same("agent_runs outcome replied (not superseded)", t.agent_runs[0].outcome, "replied");
  });

  await testCase("7   superseded, nothing written", async () => {
    const { db, args } = world({ newerInbound: true });
    await run(db, args, [toolStep(checkArea()), textStep("Yes, that ZIP is in our area.")]);
    const t = db.tables;
    same("the read-only tool ran (ok, wrote false)", [t.agent_runs[0].tool_calls[0].ok, t.agent_runs[0].tool_calls[0].wrote], [true, false]);
    same("no reply sent", outbound(db).length, 0);
    same("agent_runs outcome superseded", t.agent_runs[0].outcome, "superseded");
    same("lead untouched (no updates)", leadUpdates(db).length, 0);
  });

  await testCase("8   out of area (90210)", async () => {
    const { db, args } = world();
    await run(db, args, [
      toolStep(save({ street_address: "5 Elm St", zip: "90210" })),
      toolStep(checkArea("90210")),
      toolStep(getSlots()),
      toolStep(book()),
      textStep("Sorry, that address is outside our area. Want a call with the owner instead?"),
    ]);
    const t = db.tables;
    same("check_service_area: in_area false", resultOf(t.agent_runs[0], 1).in_area, false);
    const bookCall = t.agent_runs[0].tool_calls[3];
    fact("book_appointment ok false with the area message", bookCall.ok === false && JSON.parse(bookCall.result).error === "A visit needs a service address inside the service area.", bookCall);
    same("no appointment, work order or notification", [t.appointments.length, t.work_orders.length, t.notifications.length], [0, 0, 0]);
    fact("lead not booked", t.leads[0].status !== "booked", t.leads[0]);
  });

  await testCase("9   deadline (received 50 s ago)", async () => {
    const { db, args } = world({ receivedAgoMs: 50_000 });
    const { model } = await run(db, args, [textStep("this must never be requested")]);
    const t = db.tables;
    same("no model call made", model.calls.length, 0);
    same("agent_runs outcome fallback, error_code deadline", [t.agent_runs[0].outcome, t.agent_runs[0].error_code], ["fallback", "deadline"]);
    same("reply is the generic fallback", outbound(db)[0]?.body, formatOutbound(FALLBACK_TEXT, PREFIX));
    same("nothing written, so the lead is escalated", t.leads[0].status, "escalated");
    same("no tool calls recorded", t.agent_runs[0].tool_calls.length, 0);
  });

  await testCase("10  write-only failure (details saved, then the model throws; no booking)", async () => {
    const { db, args } = world();
    const { model } = await run(db, args, [toolStep(save()), throwStep(new Error("socket hang up"))]);
    const t = db.tables;
    same("model called twice", model.calls.length, 2);
    same("save_customer_details wrote (ok and wrote)", [t.agent_runs[0].tool_calls[0].ok, t.agent_runs[0].tool_calls[0].wrote], [true, true]);
    same("customer and location persisted", [t.customers.length, t.service_locations.length], [1, 1]);
    same("1 outbound reply", outbound(db).length, 1);
    same("reply is the generic fallback (FALLBACK_TEXT)", outbound(db)[0]?.body, formatOutbound(FALLBACK_TEXT, PREFIX));
    same("lead escalated", t.leads[0].status, "escalated");
    same("escalation written exactly once", leadUpdates(db).filter((l) => l.payload?.status === "escalated").length, 1);
    same("lead keeps the saved customer link", t.leads[0].customer_id, t.customers[0]?.id);
    same("agent_runs outcome fallback, error_code is the failure", [t.agent_runs[0].outcome, t.agent_runs[0].error_code], ["fallback", "socket hang up"]);
    same("no appointment, no notification", [t.appointments.length, t.notifications.length], [0, 0]);
  });

  await testCase("11  ~11 s remaining (maxRetries 0 under the current retry floor)", async () => {
    const { db, args } = world({ receivedAgoMs: RUN_DEADLINE_MS - 11_000 });
    const { model } = await run(db, args, [textStep("Happy to help. What is the AC doing?")]);
    const t = db.tables;
    same("not skipped: remaining - 2000 (~9 s) is positive, so 1 model call is made", model.calls.length, 1);
    optionChecks("~11 s left", model, args.receivedAt, 0);
    same("run completes normally (replied, no error_code)", [t.agent_runs[0].outcome, t.agent_runs[0].error_code], ["replied", null]);
  });

  await testCase("11b ~1.5 s remaining (call skipped)", async () => {
    const { db, args } = world({ receivedAgoMs: RUN_DEADLINE_MS - 1_500 });
    const { model } = await run(db, args, [textStep("must never be requested")]);
    const t = db.tables;
    same("no model call made", model.calls.length, 0);
    same("agent_runs outcome fallback, error_code deadline", [t.agent_runs[0].outcome, t.agent_runs[0].error_code], ["fallback", "deadline"]);
    same("reply is the generic fallback", outbound(db)[0]?.body, formatOutbound(FALLBACK_TEXT, PREFIX));
    same("lead escalated (nothing written)", t.leads[0].status, "escalated");
  });

  await testCase("12a per-call options, ~30 s remaining", async () => {
    const { db, args } = world({ receivedAgoMs: RUN_DEADLINE_MS - 30_000 });
    const { model } = await run(db, args, [toolStep(checkArea()), textStep("Yes, that ZIP is in our area.")]);
    same("2 model calls", model.calls.length, 2);
    optionChecks("~30 s left", model, args.receivedAt, 1);
    fact("the first call's timeout is capped at CLAUDE_TIMEOUT_MS", model.options[0]?.timeout === CLAUDE_TIMEOUT_MS, model.options[0]);
  });

  await testCase("12b per-call options, ~8 s remaining", async () => {
    const { db, args } = world({ receivedAgoMs: RUN_DEADLINE_MS - 8_000 });
    const { model } = await run(db, args, [toolStep(checkArea()), textStep("Yes, that ZIP is in our area.")]);
    same("2 model calls", model.calls.length, 2);
    optionChecks("~8 s left", model, args.receivedAt, 0);
  });

  await testCase("13  guardrail wiring (a two-question reply is trimmed end to end)", async () => {
    const { db, args } = world({ profile: { program_prefix: "Fieldworx Demo:" } });
    const { lines, events } = await run(db, args, [textStep("Is it running? And is anyone home?")]);
    const t = db.tables;
    same("stored reply is the one-question version", outbound(db)[0]?.body, "Fieldworx Demo: Is it running? Reply STOP to opt out.");
    same("1 outbound reply", outbound(db).length, 1);
    same("onEvent fired once with dropped 1", events, [{ type: "question_trimmed", reason: "extra_question", dropped: 1 }]);
    same("agent_runs outcome replied", t.agent_runs[0].outcome, "replied");
    fact('log line "[agent] trimmed 1 extra question(s)" written', lines.includes("[agent] trimmed 1 extra question(s)"), lines);
    same("no log line carries any message text", lines.filter((l) => l.includes("Is it running") || l.includes("anyone home")), []);
  });

  await testCase("13b compound question (the backstop cuts at 'and' end to end, with its own reason)", async () => {
    const { db, args } = world({ profile: { program_prefix: "Fieldworx Demo:" } });
    const { lines, events } = await run(db, args, [textStep("Thanks for the details. Is it running at all, and is anyone vulnerable at home?")]);
    same("stored reply is cut at the 'and'", outbound(db)[0]?.body, "Fieldworx Demo: Thanks for the details. Is it running at all? Reply STOP to opt out.");
    same("onEvent fired once, reason compound_question", events, [{ type: "question_trimmed", reason: "compound_question", dropped: 1 }]);
    fact('log line "[agent] cut a compound question" written', lines.includes("[agent] cut a compound question"), lines);
    same("no log line carries any message text", lines.filter((l) => l.includes("running at all") || l.includes("vulnerable")), []);
    same("agent_runs outcome replied", db.tables.agent_runs[0].outcome, "replied");

    const both = world({ profile: { program_prefix: "Fieldworx Demo:" } });
    const second = await run(both.db, both.args, [textStep("Is it on, and is it cold? Is anyone home?")]);
    same("a compound first question plus an extra question: both events, in order", second.events, [
      { type: "question_trimmed", reason: "extra_question", dropped: 1 },
      { type: "question_trimmed", reason: "compound_question", dropped: 1 },
    ]);
    same("stored reply is the cut first question only", outbound(both.db)[0]?.body, "Fieldworx Demo: Is it on? Reply STOP to opt out.");
  });

  // ---- returning customers and email consent ----

  // What the prompt shows under "On file for this customer:".
  const onFileBlock = (system: string) =>
    system.split("On file for this customer:\n")[1]?.split("\n\nHow to reply:")[0] ?? "";
  const leakedFrom = (lines: string[], values: string[]) =>
    values.filter((value) => lines.some((l) => l.includes(value)));
  const SAVE_FAILED_TEXT = "Couldn't save the details right now. Please try again.";

  await testCase("14  returning phone, unlinked lead, same name (linked, no duplicate, no email without consent)", async () => {
    const { db, args } = world();
    const old = seedCustomer(db, { name: "Pat Lee", email: "pat@old.example", address: "9 Oak St, 75043" });
    const { model, lines } = await run(db, args, [
      toolStep(save({ name: " pat  LEE ", street_address: "9 Oak St", zip: "75043" })),
      toolStep(checkArea()),
      toolStep(getSlots()),
      toolStep(book()),
      textStep("You're booked."),
    ]);
    const t = db.tables;
    same("first prompt: only the name, marked not yet confirmed", onFileBlock(model.calls[0].system), "- Name (from an earlier conversation, not yet confirmed): Pat Lee");
    same("still one customer, name and email untouched", t.customers.map((c) => [c.name, c.email]), [["Pat Lee", "pat@old.example"]]);
    same("the address already on record is not added twice", t.service_locations.length, 1);
    same("lead linked to the existing customer", t.leads[0].customer_id, old.id);
    same("appointment is for the existing customer", t.appointments[0]?.customer_id, old.id);
    same("book result: customer email is no_consent", resultOf(t.agent_runs[0], 3).emails, { owner: "logged", customer: "no_consent" });
    same("only the owner was emailed", t.notifications.map((n) => `${n.audience}:${n.status}`), ["owner:logged"]);
    same("consent never recorded", [t.conversations[0].email_consent_address, t.conversations[0].email_consent_at], [null, null]);
    same("no log line contains the name, address, email or phone number", leakedFrom(lines, ["Pat Lee", "Oak St", "pat@old.example", PHONE]), []);
  });

  await testCase("15  returning phone, different name (new customer; the old row is untouched)", async () => {
    const { db, args } = world();
    const old = seedCustomer(db, { name: "Pat Lee", email: "pat@old.example", address: "9 Oak St, 75043" });
    await run(db, args, [
      toolStep(save({ name: "Dana Ruiz", street_address: "40 Maple Dr", zip: "75044" })),
      textStep("Thanks Dana."),
    ]);
    const t = db.tables;
    const created = t.customers.find((c) => c.id !== old.id);
    same("two customers", t.customers.length, 2);
    same("old row: name and email untouched", t.customers.filter((c) => c.id === old.id).map((c) => [c.name, c.email]), [["Pat Lee", "pat@old.example"]]);
    fact("new row: name, this phone, email null, agent_inbound", created?.name === "Dana Ruiz" && created.phone === PHONE && created.email === null && created.source === "agent_inbound", created);
    same("lead linked to the new customer", t.leads[0].customer_id, created?.id);
    same("each customer has its own address", t.service_locations.map((l) => [l.customer_id === old.id ? "old" : "new", l.address]), [["old", "9 Oak St, 75043"], ["new", "40 Maple Dr, 75044"]]);
    same("save result: no email asked for", [resultOf(t.agent_runs[0], 0).has_email, resultOf(t.agent_runs[0], 0).confirmation_email, resultOf(t.agent_runs[0], 0).confirmations_sent], [false, "not_requested", 0]);
  });

  await testCase("16  email on the customer record but no consent -> no_consent, no customer notification", async () => {
    const { db, args } = world();
    seedCustomer(db, { name: "Pat Lee", email: "pat@old.example", address: "9 Oak St, 75043", linked: true });
    const { model } = await run(db, args, [toolStep(getSlots()), toolStep(book()), textStep("You're booked.")]);
    const t = db.tables;
    same("prompt shows the confirmed customer's email", onFileBlock(model.calls[0].system).includes("- Email: pat@old.example"), true);
    same("book result: customer email is no_consent", resultOf(t.agent_runs[0], 1).emails, { owner: "logged", customer: "no_consent" });
    same("no customer notification row", customerMail(db).length, 0);
    same("the owner was still emailed", t.notifications.map((n) => `${n.audience}:${n.status}`), ["owner:logged"]);
  });

  await testCase("17  email given after booking -> consent set, one confirmation (logged)", async () => {
    const { db, args } = world();
    const { lines } = await run(db, args, [
      toolStep(save()),
      toolStep(checkArea()),
      toolStep(getSlots()),
      toolStep(book()),
      toolStep(save({ email: "pat@example.com" })),
      textStep("Done."),
    ]);
    const t = db.tables;
    const run0 = t.agent_runs[0];
    same("book result before the email: customer is no_consent", resultOf(run0, 3).emails, { owner: "logged", customer: "no_consent" });
    same("save result: confirmation_email logged, 1 sent, email on file", [resultOf(run0, 4).confirmation_email, resultOf(run0, 4).confirmations_sent, resultOf(run0, 4).has_email], ["logged", 1, true]);
    fact("consent recorded: the address, with a timestamp", t.conversations[0].email_consent_address === "pat@example.com" && !Number.isNaN(Date.parse(t.conversations[0].email_consent_at)), t.conversations[0]);
    same("one customer notification: booking_customer, logged, to that address, for the appointment", customerMail(db).map((n) => [n.template, n.status, n.recipient, n.appointment_id]), [["booking_customer", "logged", "pat@example.com", t.appointments[0].id]]);
    same("customer row has the email", t.customers[0].email, "pat@example.com");
    same("no log line contains the name, address, email or phone number", leakedFrom(lines, ["Pat Lee", "Main St", "pat@example.com", PHONE]), []);
  });

  await testCase("18  same email again -> already_sent, nothing new", async () => {
    const { db, args } = world();
    await run(db, args, [
      toolStep(save()),
      toolStep(checkArea()),
      toolStep(getSlots()),
      toolStep(book()),
      // one round (the loop allows five), run in order
      toolStep(save({ email: "pat@example.com" }), save({ email: "pat@example.com" })),
      textStep("Done."),
    ]);
    const t = db.tables;
    const results = [4, 5].map((i) => resultOf(t.agent_runs[0], i));
    same("first email save: logged, 1 sent", [results[0].confirmation_email, results[0].confirmations_sent], ["logged", 1]);
    same("same email again: already_sent, 0 sent", [results[1].confirmation_email, results[1].confirmations_sent], ["already_sent", 0]);
    same("still one customer notification", customerMail(db).length, 1);
    same("consent written once (the timestamp is not renewed)", consentWrites(db).length, 1);
  });

  await testCase("19  email before any booking -> no_bookings; the booking is then emailed at the consent address", async () => {
    const { db, args } = world();
    await run(db, args, [
      toolStep(save({ email: "pat@example.com" })),
      toolStep(checkArea()),
      toolStep(getSlots()),
      toolStep(book()),
      textStep("You're booked."),
    ]);
    const t = db.tables;
    same("save result: no_bookings, 0 sent", [resultOf(t.agent_runs[0], 0).confirmation_email, resultOf(t.agent_runs[0], 0).confirmations_sent], ["no_bookings", 0]);
    same("consent recorded", t.conversations[0].email_consent_address, "pat@example.com");
    same("book result: customer email is logged", resultOf(t.agent_runs[0], 3).emails, { owner: "logged", customer: "logged" });
    same("customer notification goes to the consent address", customerMail(db).map((n) => n.recipient), ["pat@example.com"]);
  });

  await testCase("20  save without an email -> not_requested; the record's email and consent untouched", async () => {
    const { db, args } = world();
    seedCustomer(db, { name: "Pat Lee", email: "pat@old.example", address: "1 Main St, 75043", linked: true });
    await run(db, args, [toolStep(save()), textStep("Thanks.")]);
    const t = db.tables;
    same("save result: not_requested, 0 sent", [resultOf(t.agent_runs[0], 0).confirmation_email, resultOf(t.agent_runs[0], 0).confirmations_sent], ["not_requested", 0]);
    same("customer email unchanged", t.customers.map((c) => c.email), ["pat@old.example"]);
    same("consent not recorded, no notifications", [t.conversations[0].email_consent_address, t.notifications.length], [null, 0]);
  });

  await testCase("21  consent cannot be recorded (update fails, or the conversation row is missing)", async () => {
    for (const how of ["the update fails", "the conversation row is missing"]) {
      const { db, args } = world();
      if (how === "the update fails") db.failNext("conversations", "update", { message: "boom", code: "XX000" });
      else db.tables.conversations.length = 0;
      const { lines } = await run(db, args, [toolStep(save({ email: "pat@example.com" })), textStep("Sorry, try again.")]);
      const call = db.tables.agent_runs[0].tool_calls[0];
      same(`${how}: the save fails, and reports that it wrote`, [call.ok, call.wrote, resultOf(db.tables.agent_runs[0], 0).error], [false, true, SAVE_FAILED_TEXT]);
      same(`${how}: no consent, no email sent`, [db.tables.conversations[0]?.email_consent_address ?? null, db.tables.notifications.length], [null, 0]);
      same(`${how}: no log line contains the name, email or phone number`, leakedFrom(lines, ["Pat Lee", "pat@example.com", PHONE]), []);
    }
  });

  await testCase("22  an unconfirmed customer (found by phone only) cannot be booked", async () => {
    const { db, args } = world();
    seedCustomer(db, { name: "Pat Lee", email: null, address: "9 Oak St, 75043" });
    await run(db, args, [toolStep(getSlots()), toolStep(book()), textStep("Let me get your name first.")]);
    const t = db.tables;
    const call = t.agent_runs[0].tool_calls[1];
    same("book_appointment refuses", [call.ok, resultOf(t.agent_runs[0], 1).error], [false, "Save the customer's name first."]);
    same("no appointment, no work order, no notification", [t.appointments.length, t.work_orders.length, t.notifications.length], [0, 0, 0]);
    same("lead still unlinked", t.leads[0].customer_id, null);
  });

  await testCase("23  corrected email after booking -> confirmed again at the new address", async () => {
    const { db, args } = world();
    await run(db, args, [
      toolStep(save()),
      toolStep(checkArea()),
      toolStep(getSlots()),
      toolStep(book()),
      // one round (the loop allows five), run in order
      toolStep(
        save({ email: "pat@typo.example" }),
        save({ email: "pat@example.com" }),
        save({ email: "PAT@Example.com" }),
      ),
      textStep("Done."),
    ]);
    const t = db.tables;
    const results = [4, 5, 6].map((i) => resultOf(t.agent_runs[0], i));
    same("first address: logged, 1 sent", [results[0].confirmation_email, results[0].confirmations_sent], ["logged", 1]);
    same("corrected address: logged, 1 sent again", [results[1].confirmation_email, results[1].confirmations_sent], ["logged", 1]);
    same("same corrected address in other letter case: already_sent", [results[2].confirmation_email, results[2].confirmations_sent], ["already_sent", 0]);
    same("customer notifications went to each address once", customerMail(db).map((n) => n.recipient), ["pat@typo.example", "pat@example.com"]);
    same("consent follows the corrected address; the case-only change writes nothing", [t.conversations[0].email_consent_address, consentWrites(db).length], ["pat@example.com", 2]);
  });

  // ---- opt-out status per number (fix E) ----

  const optRows = (db: FakeSupabase) => db.tables.sms_opt_status;
  // The same inbound with a different text (and any other field changed).
  const say = (args: InboundArgs, body: string, extra: Partial<InboundArgs> = {}): InboundArgs => ({ ...args, inboundBody: body, ...extra });
  // Every write attempt, as "table:op", in order.
  const writesAfter = (db: FakeSupabase, from = 0) => db.log.slice(from).map((l) => `${l.table}:${l.op}`);
  const NORMAL_TEXT = "My AC stopped cooling";
  const MODEL_REPLY = "Happy to help. What is the AC doing?";
  const NEVER = "this must never be requested";
  const optColumns = (db: FakeSupabase) => optRows(db).map((r) => [r.business_id, r.phone, r.status, r.last_keyword ?? null, r.source]);
  const runColumns = (db: FakeSupabase) => db.tables.agent_runs.map((r) => [r.outcome, r.keyword ?? null, r.error_code]);
  const { OPT_IN_TEXT } = await import("../../src/lib/agent/keywords");

  await testCase("24  STOP -> opted_out row, run skipped_keyword with the keyword, nothing sent", async () => {
    const { db, args } = world();
    const sender = fakeSender();
    const { model, lines } = await run(db, say(args, "STOP", { conversationIsNew: true }), [], sender.send);
    same("one opt row: this business and number, opted_out, last keyword STOP, source keyword", optColumns(db), [[BIZ, PHONE, "opted_out", "STOP", "keyword"]]);
    same("one run row: skipped_keyword, keyword STOP, no error_code", runColumns(db), [["skipped_keyword", "STOP", null]]);
    same("no model call", model.calls.length, 0);
    same("no text sent (not even the opt-in text, though the conversation is new)", sender.calls.length, 0);
    same("no outbound message stored", outbound(db).length, 0);
    same("the only writes: the opt row, then the run row", writesAfter(db), ["sms_opt_status:upsert", "agent_runs:insert"]);
    same("no tool calls recorded", db.tables.agent_runs[0].tool_calls, []);
    same("no log line contains the phone number", leakedFrom(lines, [PHONE]), []);
  });

  await testCase("25  START after STOP -> the same row flips to opted_in", async () => {
    const { db, args } = world();
    const sender = fakeSender();
    await run(db, say(args, "STOP"), [], sender.send);
    const first = structuredClone(optRows(db)[0]);
    const { model } = await run(db, say(args, "start", { inboundMessageId: "inb-3" }), [], sender.send);
    same("still one opt row", optRows(db).length, 1);
    same("same row (id and created_at unchanged), updated_at moved forward", [optRows(db)[0].id === first.id, optRows(db)[0].created_at === first.created_at, optRows(db)[0].updated_at > first.updated_at], [true, true, true]);
    same("now opted_in, last keyword START, source keyword", optColumns(db), [[BIZ, PHONE, "opted_in", "START", "keyword"]]);
    same("both runs skipped_keyword, each with its keyword", runColumns(db), [["skipped_keyword", "STOP", null], ["skipped_keyword", "START", null]]);
    same("no model call, no text sent", [model.calls.length, sender.calls.length], [0, 0]);
  });

  await testCase("26  HELP and INFO -> no opt row, skipped_keyword with the keyword", async () => {
    for (const word of ["HELP", "INFO"]) {
      const { db, args } = world();
      const sender = fakeSender();
      const { model } = await run(db, say(args, word, { conversationIsNew: true }), [], sender.send);
      same(`${word}: no opt row and no write to sms_opt_status`, [optRows(db).length, db.log.filter((l) => l.table === "sms_opt_status").length], [0, 0]);
      same(`${word}: run skipped_keyword with the keyword`, runColumns(db), [["skipped_keyword", word, null]]);
      same(`${word}: no model call, no text sent`, [model.calls.length, sender.calls.length], [0, 0]);
    }
    const { db, args } = world();
    const sender = fakeSender();
    await run(db, say(args, "STOP"), [], sender.send);
    await run(db, say(args, "HELP", { inboundMessageId: "inb-3" }), [], sender.send);
    same("HELP after STOP leaves the opt-out as it was", optColumns(db), [[BIZ, PHONE, "opted_out", "STOP", "keyword"]]);
  });

  await testCase("27  normal text after STOP -> skipped_opted_out; no model, no opt-in text, no send, no writes", async () => {
    const { db, args } = world();
    const sender = fakeSender();
    await run(db, say(args, "STOP"), [], sender.send);
    const logged = db.log.length;
    const { model, lines } = await run(db, say(args, NORMAL_TEXT, { conversationIsNew: true, inboundMessageId: "inb-3" }), [textStep(NEVER)], sender.send);
    const second = db.tables.agent_runs[1];
    same("run: skipped_opted_out, no keyword, no error_code, no model, no tool calls", [second.outcome, second.keyword ?? null, second.error_code, second.model, second.tool_calls], ["skipped_opted_out", null, null, null, []]);
    same("no model call", model.calls.length, 0);
    same("no text sent (no opt-in text either, though the conversation is new)", sender.calls.length, 0);
    same("no outbound message stored", outbound(db).length, 0);
    same("the only write is the run row (no lead, customer, appointment or notification writes)", writesAfter(db, logged), ["agent_runs:insert"]);
    same("the opt row is untouched", optColumns(db), [[BIZ, PHONE, "opted_out", "STOP", "keyword"]]);
    same("no log line contains the phone number", leakedFrom(lines, [PHONE]), []);
  });

  await testCase("27b safety text after STOP -> also skipped_opted_out", async () => {
    const { db, args } = world();
    const sender = fakeSender();
    await run(db, say(args, "STOP"), [], sender.send);
    const logged = db.log.length;
    const { model } = await run(db, say(args, "I smell gas in the kitchen", { conversationIsNew: true, inboundMessageId: "inb-3" }), [textStep(NEVER)], sender.send);
    same("run: skipped_opted_out", db.tables.agent_runs[1].outcome, "skipped_opted_out");
    same("no model call, no text sent, nothing stored", [model.calls.length, sender.calls.length, outbound(db).length], [0, 0, 0]);
    same("the only write is the run row", writesAfter(db, logged), ["agent_runs:insert"]);
  });

  await testCase("28  opt check fails (DB error) -> skipped_opted_out, opt_check_failed, nothing sent", async () => {
    const { db, args } = world();
    const sender = fakeSender();
    db.failNext("sms_opt_status", "select", { message: "boom", code: "XX000" });
    const { model, lines } = await run(db, say(args, NORMAL_TEXT, { conversationIsNew: true }), [textStep(NEVER)], sender.send);
    same("no opt row exists, yet the run is skipped_opted_out with error_code opt_check_failed", runColumns(db), [["skipped_opted_out", null, "opt_check_failed"]]);
    same("no model call", model.calls.length, 0);
    same("no text sent (no opt-in text either)", sender.calls.length, 0);
    same("no outbound message stored", outbound(db).length, 0);
    same("the only write is the run row", writesAfter(db), ["agent_runs:insert"]);
    fact('fixed log line "[agent] opt-out check failed" written', lines.includes("[agent] opt-out check failed"), lines);
    same("no log line contains the phone number or the DB error text", leakedFrom(lines, [PHONE, "boom"]), []);
  });

  await testCase("29  reply send throws 21610 -> opted_out recorded (twilio_21610); the next text is skipped", async () => {
    const { db, args } = world();
    const refused = fakeSender(() => twilioOptedOut());
    const { lines } = await run(db, args, [textStep(MODEL_REPLY)], refused.send);
    same("the reply was attempted once", refused.calls.length, 1);
    same("opt row: opted_out, no keyword, source twilio_21610", optColumns(db), [[BIZ, PHONE, "opted_out", null, "twilio_21610"]]);
    same("run: send_failed with error_code 21610", runColumns(db), [["send_failed", null, "21610"]]);
    same("no outbound message stored", outbound(db).length, 0);
    same("no log line contains the phone number", leakedFrom(lines, [PHONE]), []);

    const later = fakeSender();
    const { model } = await run(db, say(args, "hello again", { inboundMessageId: "inb-3" }), [textStep(NEVER)], later.send);
    same("the next text: skipped_opted_out, no model call, nothing sent", [db.tables.agent_runs[1].outcome, model.calls.length, later.calls.length], ["skipped_opted_out", 0, 0]);
  });

  await testCase("30  opt-in text send throws 21610 -> opted_out recorded; the log line keeps the code", async () => {
    const { db, args } = world();
    const sender = fakeSender((n) => (n === 1 ? twilioOptedOut() : null));
    const { lines } = await run(db, say(args, NORMAL_TEXT, { conversationIsNew: true }), [textStep(MODEL_REPLY)], sender.send);
    same("the first text sent was the opt-in text", sender.calls[0]?.body, OPT_IN_TEXT);
    same("opt row: opted_out, no keyword, source twilio_21610", optColumns(db), [[BIZ, PHONE, "opted_out", null, "twilio_21610"]]);
    fact('log line "[agent] opt-in confirmation failed 21610" written (the code, not the HTTP status)', lines.includes("[agent] opt-in confirmation failed 21610"), lines);
    same("no log line contains the phone number", leakedFrom(lines, [PHONE]), []);
  });

  await testCase("31  send errors other than 21610 record nothing", async () => {
    const errors = [new RestException(400, 30008, "Unknown error"), new Error("socket hang up")];
    for (const isNew of [true, false]) {
      for (const error of errors) {
        const { db, args } = world();
        const sender = fakeSender(() => error);
        const { lines } = await run(db, say(args, NORMAL_TEXT, { conversationIsNew: isNew }), [textStep(MODEL_REPLY)], sender.send);
        const label = `${isNew ? "opt-in text and reply" : "reply"} fail with ${error instanceof RestException ? error.code : error.message}`;
        same(`${label}: no opt row, no write to sms_opt_status`, [optRows(db).length, db.log.filter((l) => l.table === "sms_opt_status").length], [0, 0]);
        if (isNew && error instanceof RestException) {
          fact('opt-in log line keeps the code: "[agent] opt-in confirmation failed 30008"', lines.includes("[agent] opt-in confirmation failed 30008"), lines);
        }
        // Today's behavior for any other error: the failed opt-in text is logged and the run goes on to the reply.
        same(`${label}: the run carried on (${isNew ? "opt-in text, then reply" : "reply"} attempted)`, sender.calls.length, isNew ? 2 : 1);
        same(`${label}: the run ended as send_failed, not skipped_opted_out`, db.tables.agent_runs.map((r) => r.outcome), ["send_failed"]);
      }
    }
  });

  await testCase("32  REVOKE and OPTOUT -> opted_out", async () => {
    for (const word of ["REVOKE", "OPTOUT"]) {
      const { db, args } = world();
      const sender = fakeSender();
      await run(db, say(args, word), [], sender.send);
      same(`${word}: opt row opted_out with that keyword`, optColumns(db), [[BIZ, PHONE, "opted_out", word, "keyword"]]);
      same(`${word}: run skipped_keyword with the keyword`, runColumns(db), [["skipped_keyword", word, null]]);
    }
  });

  await testCase("33  normal text after START -> the agent runs as normal", async () => {
    const { db, args } = world();
    const sender = fakeSender();
    await run(db, say(args, "STOP"), [], sender.send);
    await run(db, say(args, "START", { inboundMessageId: "inb-3" }), [], sender.send);
    // The real inbound message (inb-1) is the newest, so the reply is not superseded.
    const { model } = await run(db, say(args, NORMAL_TEXT, { conversationIsNew: true }), [textStep(MODEL_REPLY)], sender.send);
    same("the model was called once", model.calls.length, 1);
    same("run: replied", db.tables.agent_runs[2].outcome, "replied");
    fact("two texts sent: the opt-in text, then the reply", sender.calls.length === 2 && sender.calls[0].body === OPT_IN_TEXT && sender.calls[1].body.includes(MODEL_REPLY), sender.calls);
    same("the opt row stays opted_in", optColumns(db), [[BIZ, PHONE, "opted_in", "START", "keyword"]]);
  });

  await testCase("34  opt rows for another number or another business do not block this one", async () => {
    const { db, args } = world();
    seed(db, "sms_opt_status", { business_id: BIZ, phone: "+15555550111", status: "opted_out", last_keyword: "STOP", source: "keyword" });
    seed(db, "sms_opt_status", { business_id: "biz-other", phone: PHONE, status: "opted_out", last_keyword: "STOP", source: "keyword" });
    const sender = fakeSender();
    const { model } = await run(db, args, [textStep(MODEL_REPLY)], sender.send);
    same("the model was called once and the run replied", [model.calls.length, db.tables.agent_runs[0].outcome], [1, "replied"]);
    same("the reply was sent", sender.calls.length, 1);
  });

  await testCase("35  the opt row cannot be written -> logged with a fixed string; the run is still skipped", async () => {
    const { db, args } = world();
    const sender = fakeSender();
    db.failNext("sms_opt_status", "upsert", { message: "boom", code: "XX000" });
    const { model, lines } = await run(db, say(args, "STOP", { conversationIsNew: true }), [], sender.send);
    same("run: skipped_keyword with keyword STOP", runColumns(db), [["skipped_keyword", "STOP", null]]);
    same("no opt row", optRows(db).length, 0);
    same("no model call, no text sent", [model.calls.length, sender.calls.length], [0, 0]);
    fact('fixed log line "[agent] opt status record failed" written', lines.includes("[agent] opt status record failed"), lines);
    same("no log line contains the phone number or the DB error text", leakedFrom(lines, [PHONE, "boom"]), []);
  });

  await testCase("36  opt-in text refused with 21610 -> the run ends: skipped_opted_out, error_code 21610, no model, no tools, no reply", async () => {
    const { db, args } = world();
    // Only the first send (the opt-in text) is refused; a second send would succeed,
    // so a run that carried on to the reply would show up in sender.calls.
    const sender = fakeSender((n) => (n === 1 ? twilioOptedOut() : null));
    const { model, lines } = await run(db, say(args, NORMAL_TEXT, { conversationIsNew: true }), [textStep(NEVER)], sender.send);
    same("only the opt-in text was attempted: no reply send", sender.calls.map((c) => c.body), [OPT_IN_TEXT]);
    same("opt row: opted_out, no keyword, source twilio_21610", optColumns(db), [[BIZ, PHONE, "opted_out", null, "twilio_21610"]]);
    same("one run row: skipped_opted_out, no keyword, error_code 21610", runColumns(db), [["skipped_opted_out", null, "21610"]]);
    same("no model call", model.calls.length, 0);
    same("run row: no model recorded, no tool calls", [db.tables.agent_runs[0].model, db.tables.agent_runs[0].tool_calls], [null, []]);
    same("no outbound message stored", outbound(db).length, 0);
    same("the only writes: the opt row, then the run row (no tool, lead or customer writes)", writesAfter(db), ["sms_opt_status:upsert", "agent_runs:insert"]);
    fact('opt-in log line keeps the code: "[agent] opt-in confirmation failed 21610"', lines.includes("[agent] opt-in confirmation failed 21610"), lines);
    same("no log line contains the phone number", leakedFrom(lines, [PHONE]), []);
  });

  // ---- rate limits (abuse guards) ----

  const HOUR = 3_600_000;
  const DAY = 24 * HOUR;
  let seededRuns = 0;
  // `count` agent_runs rows, each `ageOf(i)` ms old, for a conversation (default:
  // this number's).
  function seedRuns(
    db: FakeSupabase,
    count: number,
    ageOf: (i: number) => number,
    options: { conversation?: string; outcome?: string; business?: string } = {},
  ) {
    for (let i = 0; i < count; i++) {
      seed(db, "agent_runs", {
        business_id: options.business ?? BIZ,
        conversation_id: options.conversation ?? CONV,
        inbound_message_id: `seeded-${++seededRuns}`,
        outcome: options.outcome ?? "replied",
        created_at: new Date(Date.now() - ageOf(i)).toISOString(),
      });
    }
  }
  // Another number with its own conversation and one inbound message, same business.
  function otherNumber(db: FakeSupabase, n: number) {
    const phone = `+155555502${String(n).padStart(2, "0")}`;
    const conv = `conv-o${n}`;
    seed(db, "conversations", { id: conv, business_id: BIZ, lead_id: LEAD, channel: "sms", customer_number: phone, business_number: BUSINESS_NUMBER, status: "active", email_consent_address: null, email_consent_at: null });
    seed(db, "messages", { id: `inb-o${n}`, business_id: BIZ, conversation_id: conv, direction: "inbound", body: NORMAL_TEXT });
    return { conv, phone, inbound: `inb-o${n}` };
  }
  // `total` counted runs spread over other numbers (5 each), all within the last day.
  function seedBusinessRuns(db: FakeSupabase, total: number) {
    for (let n = 1, left = total; left > 0; n++, left -= 5) {
      const { conv } = otherNumber(db, n);
      seedRuns(db, Math.min(5, left), (j) => (1 + j) * HOUR + n * 60_000, { conversation: conv });
    }
  }
  const lastRun = (db: FakeSupabase) => db.tables.agent_runs.at(-1)!;
  const hourAges = (i: number) => (i + 1) * 5 * 60_000; // 5, 10, 15, ... minutes ago

  await testCase("37  9 counted runs in the last hour -> the text runs; 10 -> rate_limited per_number_hour (nothing sent)", async () => {
    const nine = world();
    seedRuns(nine.db, 9, hourAges);
    const ran = await run(nine.db, nine.args, [textStep(MODEL_REPLY)]);
    same("9 counted: the model is called and the run replied", [ran.model.calls.length, lastRun(nine.db).outcome], [1, "replied"]);

    const ten = world();
    const sender = fakeSender();
    seedRuns(ten.db, 10, hourAges);
    const limited = await run(ten.db, say(ten.args, NORMAL_TEXT, { conversationIsNew: true }), [textStep(NEVER)], sender.send);
    same("10 counted: rate_limited, error_code per_number_hour, no keyword", [lastRun(ten.db).outcome, lastRun(ten.db).error_code, lastRun(ten.db).keyword ?? null], ["rate_limited", "per_number_hour", null]);
    same("no model call, no text sent (not even the opt-in text), nothing stored", [limited.model.calls.length, sender.calls.length, outbound(ten.db).length], [0, 0, 0]);
    same("the only write is the run row (no tool, lead or customer writes)", writesAfter(ten.db), ["agent_runs:insert"]);
    same("no tool calls recorded", lastRun(ten.db).tool_calls, []);
    same("no log line contains the phone number", leakedFrom(limited.lines, [PHONE]), []);

    const gas = world();
    seedRuns(gas.db, 10, hourAges);
    const gasRun = await run(gas.db, say(gas.args, "I smell gas in the kitchen"), [textStep(NEVER)]);
    same("a safety text over the limit is rate limited too", [lastRun(gas.db).outcome, gasRun.model.calls.length, outbound(gas.db).length], ["rate_limited", 0, 0]);
  });

  await testCase("38  24 counted runs in 24 h (none in the last hour) -> the text runs; 25 -> rate_limited per_number_day", async () => {
    const spread = (i: number) => (2 + i * 0.5) * HOUR; // 2 h .. 14 h ago
    const twentyFour = world();
    seedRuns(twentyFour.db, 24, spread);
    const ran = await run(twentyFour.db, twentyFour.args, [textStep(MODEL_REPLY)]);
    same("24 counted: the run replied", [ran.model.calls.length, lastRun(twentyFour.db).outcome], [1, "replied"]);

    const twentyFive = world();
    const sender = fakeSender();
    seedRuns(twentyFive.db, 25, spread);
    const limited = await run(twentyFive.db, say(twentyFive.args, NORMAL_TEXT, { conversationIsNew: true }), [textStep(NEVER)], sender.send);
    same("25 counted: rate_limited, error_code per_number_day", [lastRun(twentyFive.db).outcome, lastRun(twentyFive.db).error_code], ["rate_limited", "per_number_day"]);
    same("no model call, no text sent", [limited.model.calls.length, sender.calls.length], [0, 0]);
  });

  await testCase("39  99 counted runs business-wide in 24 h -> the text runs; 100 -> rate_limited per_business_day", async () => {
    const ninetyNine = world();
    seedBusinessRuns(ninetyNine.db, 99);
    const ran = await run(ninetyNine.db, ninetyNine.args, [textStep(MODEL_REPLY)]);
    same("99 counted: the run replied", [ran.model.calls.length, lastRun(ninetyNine.db).outcome], [1, "replied"]);

    const hundred = world();
    const sender = fakeSender();
    seedBusinessRuns(hundred.db, 100);
    same("this number has no runs of its own", hundred.db.tables.agent_runs.filter((r) => r.conversation_id === CONV).length, 0);
    const limited = await run(hundred.db, say(hundred.args, NORMAL_TEXT, { conversationIsNew: true }), [textStep(NEVER)], sender.send);
    same("100 counted: rate_limited, error_code per_business_day", [lastRun(hundred.db).outcome, lastRun(hundred.db).error_code], ["rate_limited", "per_business_day"]);
    same("no model call, no text sent", [limited.model.calls.length, sender.calls.length], [0, 0]);

    const elsewhere = world();
    seedRuns(elsewhere.db, 100, (i) => (1 + (i % 20)) * HOUR, { business: "biz-other", conversation: "conv-elsewhere" });
    const free = await run(elsewhere.db, elsewhere.args, [textStep(MODEL_REPLY)]);
    same("100 runs of a different business do not count", [free.model.calls.length, lastRun(elsewhere.db).outcome], [1, "replied"]);
  });

  await testCase("40  skipped_keyword, skipped_opted_out and rate_limited runs do not count", async () => {
    const { db, args } = world();
    seedRuns(db, 9, hourAges);
    seedRuns(db, 10, hourAges, { outcome: "skipped_keyword" });
    seedRuns(db, 10, hourAges, { outcome: "skipped_opted_out" });
    seedRuns(db, 10, hourAges, { outcome: "rate_limited" });
    const other = otherNumber(db, 1);
    seedRuns(db, 100, (i) => (1 + (i % 20)) * HOUR, { conversation: other.conv, outcome: "rate_limited" });
    seedRuns(db, 100, (i) => (1 + (i % 20)) * HOUR, { conversation: other.conv, outcome: "skipped_keyword" });
    const ran = await run(db, args, [textStep(MODEL_REPLY)]);
    same("9 counted among 30 uncounted (and 200 uncounted business-wide): the run replied", [ran.model.calls.length, lastRun(db).outcome], [1, "replied"]);
  });

  await testCase("41  runs older than the window do not count", async () => {
    // Just outside the hour (61 min and older): 10 of them leave the hour count at 0.
    const hour = world();
    seedRuns(hour.db, 10, (i) => 61 * 60_000 + i * 60_000);
    same("10 runs 61+ minutes old: the run replied", [(await run(hour.db, hour.args, [textStep(MODEL_REPLY)])).model.calls.length, lastRun(hour.db).outcome], [1, "replied"]);
    // Just outside the day: 25 runs older than 24 h.
    const day = world();
    seedRuns(day.db, 25, (i) => DAY + 60_000 + i * 60_000);
    same("25 runs older than 24 h: the run replied", [(await run(day.db, day.args, [textStep(MODEL_REPLY)])).model.calls.length, lastRun(day.db).outcome], [1, "replied"]);
    // Business: 100 runs older than 24 h.
    const business = world();
    const other = otherNumber(business.db, 1);
    seedRuns(business.db, 100, (i) => DAY + 60_000 + i * 60_000, { conversation: other.conv });
    same("100 business runs older than 24 h: the run replied", [(await run(business.db, business.args, [textStep(MODEL_REPLY)])).model.calls.length, lastRun(business.db).outcome], [1, "replied"]);
    // Control: the same 10 runs just inside the hour do block.
    const inside = world();
    seedRuns(inside.db, 10, (i) => 50 * 60_000 + i * 10_000);
    await run(inside.db, inside.args, [textStep(NEVER)]);
    same("control: 10 runs 50 minutes old: rate_limited per_hour", [lastRun(inside.db).outcome, lastRun(inside.db).error_code], ["rate_limited", "per_number_hour"]);
  });

  await testCase("42  a count query error -> the run goes ahead, with one fixed log line", async () => {
    const fail = async (label: string, arrange: (db: FakeSupabase) => void, expectedOutcome: string) => {
      const { db, args } = world();
      seedRuns(db, 10, hourAges);
      arrange(db);
      const { model, lines } = await run(db, args, [textStep(MODEL_REPLY)]);
      same(`${label}: outcome`, lastRun(db).outcome, expectedOutcome);
      same(`${label}: the model was ${expectedOutcome === "replied" ? "called" : "not called"}`, model.calls.length, expectedOutcome === "replied" ? 1 : 0);
      fact(`${label}: fixed log line written`, lines.includes("[agent] rate limit check failed"), lines);
      same(`${label}: no log line contains the phone number or the DB error text`, leakedFrom(lines, [PHONE, "boom"]), []);
    };
    const boom = { message: "boom", code: "XX000" };
    await fail("conversations lookup fails (10 in the hour would block)", (db) => db.failNext("conversations", "select", boom), "replied");
    await fail("number runs query fails and business count fails", (db) => { db.failNext("agent_runs", "select", boom); db.failNext("agent_runs", "select", boom); }, "replied");
    await fail("number check fails but the business is over its limit: still limited", (db) => { db.failNext("conversations", "select", boom); seedBusinessRuns(db, 100); }, "rate_limited");
  });

  await testCase("43  STOP while over the limit is still recorded (keywords first); opt-out beats the limit", async () => {
    const { db, args } = world();
    seedRuns(db, 10, hourAges);
    const sender = fakeSender();
    const stop = await run(db, say(args, "STOP"), [], sender.send);
    same("opt row: opted_out, keyword STOP, source keyword", optColumns(db), [[BIZ, PHONE, "opted_out", "STOP", "keyword"]]);
    same("run: skipped_keyword with the keyword (not rate_limited)", [lastRun(db).outcome, lastRun(db).keyword], ["skipped_keyword", "STOP"]);
    same("no model call, no text sent", [stop.model.calls.length, sender.calls.length], [0, 0]);
    await run(db, say(args, NORMAL_TEXT, { inboundMessageId: "inb-3" }), [textStep(NEVER)], sender.send);
    same("a normal text after: skipped_opted_out (the opt-out check comes before the limit), no error_code", [lastRun(db).outcome, lastRun(db).error_code], ["skipped_opted_out", null]);
  });

  await testCase("44  another number is not limited by this number's runs", async () => {
    const { db, args } = world();
    seedRuns(db, 10, hourAges);
    const other = otherNumber(db, 1);
    const ran = await run(db, { ...args, customerNumber: other.phone, conversationId: other.conv, inboundMessageId: other.inbound }, [textStep(MODEL_REPLY)]);
    same("the other number's text runs: the model is called and the run replied", [ran.model.calls.length, lastRun(db).outcome], [1, "replied"]);
    await run(db, args, [textStep(NEVER)]);
    same("control: this number, with the same 10 runs, is limited", [lastRun(db).outcome, lastRun(db).error_code], ["rate_limited", "per_number_hour"]);
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
  console.log("loop tests aborted:", err instanceof Error ? err.stack : String(err));
  process.exit(2);
});
