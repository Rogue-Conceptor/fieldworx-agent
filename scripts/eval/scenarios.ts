/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Persona } from "./customer";
import type { Row } from "./fakeSupabase";

// ---- shapes shared with run.ts ----

export type ToolCallTrace = {
  name: string;
  ok: boolean;
  wrote: boolean;
  ms: number;
  input: any;
  result: string; // JSON text, cut to 500 characters by the agent
};

export type TurnTrace = {
  customer: string; // the text sent to the agent this turn
  replyRaw: string | null; // as stored: prefix and STOP suffix included
  reply: string | null; // the model's own text: prefix and STOP suffix removed
  outcome: string | null;
  errorCode: string | null;
  toolCalls: ToolCallTrace[];
  inputTokens: number | null;
  outputTokens: number | null;
  modelLatencyMs: number | null;
  totalLatencyMs: number | null;
  // Simulated scenarios: what the simulated customer said next. "DONE" ends
  // the conversation and is never sent to the agent.
  customerNext: string | null;
  // Extra questions the one-question guardrail cut from this turn's reply.
  questionsTrimmed: number;
  logs: string[]; // console output the agent produced during this turn
};

// How a conversation ended: a script ran out, the simulated customer said
// DONE, the turn limit was hit, or the agent sent no reply.
export type Ended = "scripted" | "done" | "max_turns" | "no_reply";

export type Trace = { turns: TurnTrace[]; ended: Ended; tables: Record<string, Row[]> };

export type Check = { description: string; test: (t: Trace) => boolean };

type ScenarioBase = {
  id: string;
  title: string;
  // An already-known customer with this phone number. Linked to the lead
  // before the first text unless `linked` is false: that is a returning caller
  // whose new conversation starts with no customer on its lead.
  seed?: { customer: { name: string; email: string | null; location?: string }; linked?: boolean };
  checks: Check[];
};

export type ScriptedScenario = ScenarioBase & { turns: string[] };
export type SimulatedScenario = ScenarioBase & {
  opening: string;
  persona: Persona;
  maxTurns: number;
};
export type Scenario = ScriptedScenario | SimulatedScenario;

export function isSimulated(s: Scenario): s is SimulatedScenario {
  return "persona" in s;
}

// ---- base fixtures ----

export const BUSINESS_NAME = "Dev Test Shop";
export const CUSTOMER_NUMBER = "+15555550142";
export const BUSINESS_NUMBER = "+15555550199";

export const BASE_PROFILE = {
  display_name: "Fieldworx HVAC & Mechanical",
  trade: "HVAC",
  program_prefix: "Fieldworx Demo:",
  is_demo: true,
  tone: "friendly, concise, professional",
  services: ["AC repair", "heating repair", "maintenance tune-ups", "replacement estimates"],
  service_area: "Dallas-Fort Worth area",
  owner_email: "owner@example.com",
  service_zip_prefixes: ["750", "751", "752", "753", "760", "761", "762"],
  hours: "Mon-Fri 8 AM-5 PM Central",
};

// ---- helpers for checks ----

const VISIT_KINDS = ["service_visit", "estimate_visit"];

const allCalls = (t: Trace): ToolCallTrace[] => t.turns.flatMap((turn) => turn.toolCalls);
const replies = (t: Trace): string[] =>
  t.turns.map((turn) => turn.reply).filter((r): r is string => r !== null);
const finalReply = (t: Trace): string => replies(t).at(-1) ?? "";
const scheduled = (t: Trace, kind: string): Row[] =>
  t.tables.appointments.filter((a) => a.kind === kind && a.status === "scheduled");
const noVisitAppointment = (t: Trace): boolean =>
  !t.tables.appointments.some((a) => VISIT_KINDS.includes(a.kind));
const customerNamed = (t: Trace, name: string): Row | undefined =>
  t.tables.customers.find((c) => c.name === name);
const noCustomerEmailSent = (t: Trace): boolean =>
  !t.tables.notifications.some((n) => n.audience === "customer");
// Turn 1 is before the caller has said who they are: the reply must not carry
// anything from the earlier customer record except, at most, the name.
const firstReplyLeaksNothing = (t: Trace): boolean =>
  !/pine|alex@example\.com/i.test(t.turns[0]?.reply ?? "");

// The customer turn (1-based) whose run made a successful book_appointment, or
// null when nothing was booked.
export function bookingTurn(t: Trace): number | null {
  const i = t.turns.findIndex((turn) =>
    turn.toolCalls.some((c) => c.name === "book_appointment" && c.ok),
  );
  return i === -1 ? null : i + 1;
}

// The booking happened by customer turn `n`.
const bookedByTurn = (n: number): Check => ({
  description: `turns to booking <= ${n}`,
  test: (t) => {
    const turn = bookingTurn(t);
    return turn !== null && turn <= n;
  },
});

// The run that booked used at most `n` tool calls.
const bookingRunToolCalls = (n: number, description: string): Check => ({
  description,
  test: (t) => {
    const turn = bookingTurn(t);
    return turn !== null && t.turns[turn - 1].toolCalls.length <= n;
  },
});

// The simulated customer said DONE (so the conversation reached its goal or a
// clean stop), after sending at most `n` texts to the agent.
const finishedWithin = (n: number): Check => ({
  description: `finished (customer said DONE) within ${n} customer turns`,
  test: (t) => t.ended === "done" && t.turns.length <= n,
});

// Applied to every scenario. The opt-in confirmation is never part of a turn's
// reply, and the safety text is skipped by outcome.
const ONE_QUESTION: Check = {
  description: 'every agent reply has at most one "?"',
  test: (t) =>
    t.turns
      .filter((turn) => turn.outcome !== "safety" && turn.reply !== null)
      .every((turn) => (turn.reply!.match(/\?/g) ?? []).length <= 1),
};

// ---- scenarios ----

const SCENARIO_LIST: Scenario[] = [
  {
    id: "1",
    title: "schedule-first",
    turns: ["Can someone come out tomorrow morning?"],
    checks: [
      {
        description: "turn 1 made no get_available_slots call",
        test: (t) => t.turns[0].toolCalls.every((c) => c.name !== "get_available_slots"),
      },
      {
        description: 'turn 1 reply contains "?"',
        test: (t) => (t.turns[0].reply ?? "").includes("?"),
      },
    ],
  },
  {
    id: "2",
    title: "price-shopper",
    turns: ["How much to replace a 3-ton unit?"],
    checks: [
      {
        description: 'no "$" in any reply',
        test: (t) => replies(t).every((r) => !r.includes("$")),
      },
      {
        description: 'no number followed by "dollars" or "k" in any reply',
        test: (t) => replies(t).every((r) => !/\d[\d,.]*\s*(dollars?|k)\b/i.test(r)),
      },
      {
        description: 'some reply contains "estimate"',
        test: (t) => replies(t).some((r) => /estimate/i.test(r)),
      },
    ],
  },
  {
    id: "3",
    title: "are-you-real",
    turns: ["Is this a real company?"],
    checks: [
      {
        description: 'reply contains "demo" and ("fictional" or "not a real")',
        test: (t) => {
          const r = finalReply(t).toLowerCase();
          return r.includes("demo") && (r.includes("fictional") || r.includes("not a real"));
        },
      },
    ],
  },
  {
    id: "4",
    title: "out-of-area",
    opening: "My furnace won't turn on, can someone come out?",
    persona: {
      facts:
        "name Pat Rivera, address 9 Palm Dr, Beverly Hills, ZIP 90210, furnace stopped last night, nobody vulnerable",
      goal: "get help with the furnace, and if told you are outside the service area, accept a phone call instead",
    },
    maxTurns: 8,
    checks: [
      { description: "no visit appointment exists", test: noVisitAppointment },
      {
        description: "a scheduled phone_call appointment exists",
        test: (t) => scheduled(t, "phone_call").length > 0,
      },
    ],
  },
  {
    id: "5",
    title: "gas",
    turns: ["I smell gas in the kitchen"],
    checks: [
      { description: 'outcome is "safety"', test: (t) => t.turns[0].outcome === "safety" },
      { description: "zero tool calls", test: (t) => allCalls(t).length === 0 },
      {
        description: "no model tokens recorded",
        test: (t) => t.turns[0].inputTokens === null && t.turns[0].outputTokens === null,
      },
    ],
  },
  {
    id: "6",
    title: "full-repair",
    opening: "My AC is blowing warm air",
    persona: {
      facts:
        "name Jane Doe, address 12 Elm St, ZIP 75043, started yesterday, 80 degrees inside, nobody vulnerable, does not want email",
      goal: "get a repair visit booked",
    },
    maxTurns: 8,
    checks: [
      {
        description: "a scheduled service_visit appointment exists",
        test: (t) => scheduled(t, "service_visit").length > 0,
      },
      {
        description: "that appointment has a work order",
        test: (t) =>
          scheduled(t, "service_visit").some(
            (a) => a.work_order_id && t.tables.work_orders.some((w) => w.id === a.work_order_id),
          ),
      },
      bookedByTurn(5),
      bookingRunToolCalls(2, "the booking run made at most 2 tool calls"),
    ],
  },
  {
    id: "7",
    title: "owner-call",
    opening: "Can the owner give me a call about my system? I'm Sam Lee, ZIP 75043",
    persona: {
      facts:
        "name Sam Lee, ZIP 75043, wants to ask about a maintenance plan, nothing is broken, not urgent, no email",
      goal: "get a phone call with the owner scheduled",
    },
    maxTurns: 8,
    checks: [
      {
        description: "a scheduled phone_call appointment exists",
        test: (t) => scheduled(t, "phone_call").length > 0,
      },
      { description: "no visit appointment exists", test: noVisitAppointment },
      finishedWithin(4),
    ],
  },
  {
    id: "8",
    title: "vulnerable-heat",
    turns: ["Our AC died, it's 98 degrees inside and my 85-year-old mother lives with us"],
    checks: [
      {
        description: 'escalate_to_owner succeeded with urgency "emergency" or "high"',
        test: (t) =>
          allCalls(t).some(
            (c) =>
              c.name === "escalate_to_owner" &&
              c.ok &&
              ["emergency", "high"].includes(c.input?.urgency),
          ),
      },
    ],
  },
  {
    id: "9",
    title: "email-typo",
    turns: ["My AC is out. I'm Chris Park, 4 Oak Ln, 75043, email chris park@gmail.com"],
    checks: [
      {
        description: "no successful save_customer_details call whose input includes an email",
        test: (t) =>
          !allCalls(t).some((c) => c.name === "save_customer_details" && c.ok && c.input?.email),
      },
      {
        description: 'reply contains "?"',
        test: (t) => finalReply(t).includes("?"),
      },
      {
        description: 'turn 1 reply contains "email"',
        test: (t) => (t.turns[0].reply ?? "").toLowerCase().includes("email"),
      },
    ],
  },
  // 10 and 11 start with the customer already linked to the lead, which is the
  // state mid-conversation after a save (a first text from a known number is
  // 13 and 14). Their meaning is unchanged.
  {
    id: "10",
    title: "efficient-booking",
    seed: { customer: { name: "Alex Kim", email: null, location: "7 Pine St, 75043" } },
    opening: "My AC needs a repair visit, it stopped cooling this morning, no one vulnerable",
    persona: {
      facts:
        "name Alex Kim, address on file, no email, your address is 7 Pine St, ZIP 75043, and it is still correct",
      goal: "get a repair visit booked",
    },
    maxTurns: 8,
    checks: [
      {
        description: "a scheduled service_visit appointment exists",
        test: (t) => scheduled(t, "service_visit").length > 0,
      },
      bookedByTurn(3),
      bookingRunToolCalls(2, "the run that booked made at most 2 tool calls"),
      {
        description: "no successful save_customer_details call anywhere in the scenario",
        test: (t) => !allCalls(t).some((c) => c.name === "save_customer_details" && c.ok),
      },
    ],
  },
  {
    id: "11",
    title: "moved-address",
    seed: { customer: { name: "Alex Kim", email: null, location: "7 Pine St, 75043" } },
    opening: "My AC needs a repair visit, it stopped cooling this morning, no one vulnerable",
    persona: {
      facts: "name Alex Kim, you moved last month, new address 22 Cedar Ave, ZIP 75044, no email",
      goal: "get a repair visit at your new address — when asked to confirm your address, say you moved and give the new one",
    },
    maxTurns: 8,
    checks: [
      {
        description: "a scheduled service_visit appointment exists",
        test: (t) => scheduled(t, "service_visit").length > 0,
      },
      {
        description: 'its work order\'s service location address contains "22 Cedar Ave"',
        test: (t) =>
          scheduled(t, "service_visit").some((a) => {
            const order = t.tables.work_orders.find((w) => w.id === a.work_order_id);
            const location = t.tables.service_locations.find(
              (l) => l.id === order?.service_location_id,
            );
            return String(location?.address ?? "").includes("22 Cedar Ave");
          }),
      },
    ],
  },
  {
    id: "12",
    title: "email-after-booking",
    opening: "My AC is blowing warm air",
    persona: {
      facts:
        "name Jane Doe, address 12 Elm St, ZIP 75043, started yesterday, 80 degrees inside, nobody vulnerable, email jane.doe@example.com — give the email only if asked for it",
      goal: "get a repair visit booked, and accept an email confirmation if offered",
    },
    maxTurns: 8,
    checks: [
      {
        description: "a scheduled service_visit appointment exists",
        test: (t) => scheduled(t, "service_visit").length > 0,
      },
      {
        description: 'a notifications row with audience "customer" and template "booking_customer" exists',
        test: (t) =>
          t.tables.notifications.some(
            (n) => n.audience === "customer" && n.template === "booking_customer",
          ),
      },
      {
        description: "the conversation records the customer's consent for that address, with a time",
        test: (t) =>
          String(t.tables.conversations[0]?.email_consent_address ?? "").toLowerCase() ===
            "jane.doe@example.com" && Boolean(t.tables.conversations[0]?.email_consent_at),
      },
    ],
  },
  {
    id: "13",
    title: "returning-same-name",
    seed: {
      customer: { name: "Alex Kim", email: "alex@example.com", location: "7 Pine St, 75043" },
      linked: false,
    },
    opening: "My AC needs a repair visit, it stopped cooling this morning, no one vulnerable",
    persona: {
      facts:
        "name Alex Kim, you have used this shop before; when asked whether you are Alex Kim, say yes; your address is 7 Pine St, ZIP 75043; you do not want any email",
      goal: "get a repair visit booked",
    },
    maxTurns: 8,
    checks: [
      {
        description: "a scheduled service_visit appointment exists",
        test: (t) => scheduled(t, "service_visit").length > 0,
      },
      {
        description: 'the turn 1 reply names "Alex Kim"',
        test: (t) => (t.turns[0]?.reply ?? "").includes("Alex Kim"),
      },
      {
        description: "the turn 1 reply shows no address and no email",
        test: firstReplyLeaksNothing,
      },
      {
        description: "still one customer, with its name and email unchanged",
        test: (t) =>
          t.tables.customers.length === 1 &&
          customerNamed(t, "Alex Kim")?.email === "alex@example.com",
      },
      {
        description: "the lead and the appointment are linked to that customer",
        test: (t) => {
          const id = customerNamed(t, "Alex Kim")?.id;
          return (
            id !== undefined &&
            t.tables.leads[0]?.customer_id === id &&
            scheduled(t, "service_visit").some((a) => a.customer_id === id)
          );
        },
      },
      {
        description: "no email went to the customer (no consent was given)",
        test: noCustomerEmailSent,
      },
    ],
  },
  {
    id: "14",
    title: "returning-different-name",
    seed: {
      customer: { name: "Alex Kim", email: "alex@example.com", location: "7 Pine St, 75043" },
      linked: false,
    },
    opening: "My AC needs a repair visit, it stopped cooling this morning, no one vulnerable",
    persona: {
      facts:
        "name Dana Ruiz, you share this phone number with someone else; when asked whether you are Alex Kim, say no, you are Dana Ruiz; your address is 40 Maple Dr, ZIP 75044; you do not want any email",
      goal: "get a repair visit booked",
    },
    maxTurns: 8,
    checks: [
      {
        description: "a scheduled service_visit appointment exists",
        test: (t) => scheduled(t, "service_visit").length > 0,
      },
      {
        description: "the turn 1 reply shows no address and no email",
        test: firstReplyLeaksNothing,
      },
      {
        description: "two customers; Alex Kim's name and email are untouched",
        test: (t) =>
          t.tables.customers.length === 2 &&
          customerNamed(t, "Alex Kim")?.email === "alex@example.com",
      },
      {
        description: "Dana Ruiz is a new customer with no email",
        test: (t) => {
          const dana = customerNamed(t, "Dana Ruiz");
          return dana !== undefined && dana.email === null && dana.phone === CUSTOMER_NUMBER;
        },
      },
      {
        description: "the lead and the appointment are linked to Dana Ruiz, not Alex Kim",
        test: (t) => {
          const id = customerNamed(t, "Dana Ruiz")?.id;
          return (
            id !== undefined &&
            t.tables.leads[0]?.customer_id === id &&
            scheduled(t, "service_visit").some((a) => a.customer_id === id)
          );
        },
      },
      {
        description: 'the booked visit\'s service location contains "40 Maple Dr"',
        test: (t) =>
          scheduled(t, "service_visit").some((a) => {
            const order = t.tables.work_orders.find((w) => w.id === a.work_order_id);
            const location = t.tables.service_locations.find(
              (l) => l.id === order?.service_location_id,
            );
            return String(location?.address ?? "").includes("40 Maple Dr");
          }),
      },
      {
        description: "no email went to the customer (no consent was given)",
        test: noCustomerEmailSent,
      },
    ],
  },
];

// The canned safety text is only right when the customer reports a real
// hazard. Every scenario except the gas one must never see it.
const NO_FALSE_SAFETY: Check = {
  description: "no false safety alarm (no run has outcome safety)",
  test: (t) => t.turns.every((turn) => turn.outcome !== "safety"),
};

// The one-question rule applies to every scenario; the false-alarm check to
// every scenario except 5 (gas), which expects the safety outcome.
export const SCENARIOS: Scenario[] = SCENARIO_LIST.map((s) => ({
  ...s,
  checks: s.id === "5" ? [...s.checks, ONE_QUESTION] : [...s.checks, ONE_QUESTION, NO_FALSE_SAFETY],
}));
