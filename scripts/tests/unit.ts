// Permanent unit tests for the agent's pure logic. No framework: plain checks
// that print PASS/FAIL per case, a total, and exit 1 on any failure.
//
//   npm run test:unit
//
// Nothing here touches the network or a database.
import type { ToolContext } from "../../src/lib/agent/tools";

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, actual?: unknown) {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  actual=${JSON.stringify(actual)}`}`);
}
function eq(name: string, actual: unknown, expected: unknown) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), actual);
}
function section(title: string) {
  console.log(`\n== ${title} ==`);
}

type Kind = "opt_out" | "opt_in" | "help" | "safety" | "normal";

async function main() {
  // The agent modules read these two settings when they are first imported.
  process.env.EMAIL_MODE = "log";
  process.env.OUTBOUND_MODE = "log";

  let fetchCalls = 0;
  globalThis.fetch = (() => {
    fetchCalls++;
    throw new Error("unit tests must not use the network");
  }) as typeof fetch;

  const { classifyInbound } = await import("../../src/lib/agent/keywords");
  const { formatOutbound, limitQuestions, stripForHistory } = await import("../../src/lib/agent/format");
  const { isValidEmail, normalizeZip, zipInArea } = await import("../../src/lib/agent/area");
  const { buildSlots, centralToUtc, openSlots } = await import("../../src/lib/agent/clock");
  const { bookingCustomerEmail, escalationOwnerEmail } = await import("../../src/lib/agent/emails");
  const { confirmationOutcome, executeTool, TOOL_DEFINITIONS } = await import("../../src/lib/agent/tools");
  const { formatOnFile } = await import("../../src/lib/agent/onfile");
  const { buildSystemPrompt } = await import("../../src/lib/agent/prompt");
  const { sendEmail } = await import("../../src/lib/agent/notify");

  const P = "Fieldworx Demo:";

  // ------------------------------------------------------------------
  section("classifyInbound: negation-aware safety (this round, 6 new cases)");
  // `keyword` is the matched keyword for the three keyword kinds, null otherwise.
  const cls = (input: string, expected: Kind, keyword: string | null = null) => {
    const got = classifyInbound(input);
    check(
      `classifyInbound(${JSON.stringify(input)}) -> ${expected}${keyword ? ` (${keyword})` : ""}`,
      got.kind === expected && got.keyword === keyword,
      got,
    );
  };
  cls("There's no heat and I smell gas", "safety");
  cls("I don't have heat I smell gas", "safety");
  cls("No burning smell or smoke", "normal");
  cls("no smoke or burning smell", "normal");
  cls("No gas smell and no smoke", "normal");
  cls("No AC and smoke coming from the unit", "safety");

  section("classifyInbound: previous round's 12 cases");
  cls("No burning smell or smoke", "normal");
  cls("No gas smell, no smoke, just warm air", "normal");
  cls("Nothing smells like gas", "normal");
  cls("I don't know, I smell gas", "safety");
  cls("No AC, but I smell gas", "safety");
  cls("There's no smoke but there's a burning smell", "safety");
  cls("The CO alarm won't stop going off", "safety");
  cls("I smell gas in the kitchen", "safety");
  cls("smoke coming from the outside unit", "safety");
  cls("it's burning up in here and the AC is out", "normal");
  cls("STOP", "opt_out", "STOP");
  cls("yes", "normal");

  section("classifyInbound: earlier cases (reconstructed from docs/TESTING_INITIATIVES.md line 87)");
  cls("STOP", "opt_out", "STOP");
  cls("stop.", "opt_out", "STOP");
  cls("Help", "help", "HELP");
  cls("cancel", "opt_out", "CANCEL");
  cls("yes", "normal");
  cls("Yes, Tuesday works", "normal");
  cls("please stop by tomorrow", "normal");
  cls("it's burning up in here", "normal");
  cls("I have a burning smell coming from the vents", "safety");
  cls("I think I smell gas", "safety");
  cls("my carbon monoxide alarm is going off", "safety");
  cls("there is smoke coming from the vent", "safety");
  cls("sparks coming from the panel", "safety");

  section("classifyInbound: the 12 carrier keywords (kind and matched keyword)");
  for (const k of ["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT", "OPTOUT", "REVOKE"]) cls(k, "opt_out", k);
  for (const k of ["START", "UNSTOP"]) cls(k, "opt_in", k);
  for (const k of ["HELP", "INFO"]) cls(k, "help", k);

  section("classifyInbound: keyword normalization (trim, case, trailing punctuation) and near-misses");
  cls("stop.", "opt_out", "STOP");
  cls("Revoke!", "opt_out", "REVOKE");
  cls("  unstop  ", "opt_in", "UNSTOP");
  cls("Info?", "help", "INFO");
  cls("(STOP)", "normal");
  cls("stop all", "normal");
  cls("please stop", "normal");

  // ------------------------------------------------------------------
  section("formatOutbound / stripForHistory (earlier cases, reconstructed)");
  const plain = formatOutbound("Hello there.", P);
  check("formatter: adds prefix and STOP line", plain === `${P} Hello there. Reply STOP to opt out.`, plain);
  const dup = formatOutbound("Happy to help. Reply STOP to opt out.", P);
  check("formatter: STOP appears exactly once even if the model wrote its own", (dup.match(/Reply STOP/g) ?? []).length === 1, dup);
  const md = formatOutbound("**Bold** move and `code` here.", P);
  check("formatter: strips markdown", !md.includes("*") && !md.includes("`"), md);
  const sentences = "This is a fairly long sentence about the work we do. ".repeat(8);
  const capped = stripForHistory(formatOutbound(sentences, P), P);
  check("formatter: caps at a sentence boundary (<= 280, ends with a period)", capped.length <= 280 && capped.endsWith("."), { length: capped.length, tail: capped.slice(-20) });
  const hard = stripForHistory(formatOutbound("x".repeat(400), P), P);
  check("formatter: hard-caps unpunctuated text at 280", hard.length === 280, hard.length);
  const original = "Thanks, we can help with that.";
  check("history round trip is exact", stripForHistory(formatOutbound(original, P), P) === original, stripForHistory(formatOutbound(original, P), P));

  section("limitQuestions / formatOutbound one-question rule");
  const limit = (input: string, expectedText: string, expectedDropped: number) => {
    const r = limitQuestions(input);
    check(`limitQuestions(${JSON.stringify(input)})`, r.text === expectedText && r.dropped === expectedDropped, r);
  };
  limit("Is it running? And is anyone vulnerable?", "Is it running?", 1);
  limit("Thanks. Is it running? I can help. Also, is anyone home?", "Thanks. Is it running? I can help.", 1);
  const booked = "You're booked for Mon Oct 5, 9-11 AM. This is a demo booking. Would you like an email?";
  limit(booked, booked, 0);
  limit("No questions here.", "No questions here.", 0);
  limit("What's your ZIP? What's your name? What's your address?", "What's your ZIP?", 2);
  limit("It's 98.6 degrees. Is that right?", "It's 98.6 degrees. Is that right?", 0);
  const two = formatOutbound("Is it on? Is it cooling?", P);
  check('formatOutbound("Is it on? Is it cooling?") === "Fieldworx Demo: Is it on? Reply STOP to opt out."', two === `${P} Is it on? Reply STOP to opt out.`, two);

  // ------------------------------------------------------------------
  section("area: normalizeZip, zipInArea, isValidEmail");
  eq('normalizeZip "75043"', normalizeZip("75043"), "75043");
  eq('normalizeZip "Dallas TX 75043-1234"', normalizeZip("Dallas TX 75043-1234"), "75043");
  eq('normalizeZip "7504"', normalizeZip("7504"), null);
  eq('normalizeZip "12345 Main St, Dallas 75043" (last 5-digit run wins)', normalizeZip("12345 Main St, Dallas 75043"), "75043");
  eq('normalizeZip "75043-1234"', normalizeZip("75043-1234"), "75043");
  eq('zipInArea("75043", ["750","751"])', zipInArea("75043", ["750", "751"]), true);
  eq('zipInArea("90210", ["750"])', zipInArea("90210", ["750"]), false);
  eq('zipInArea("75043", [])', zipInArea("75043", []), false);
  eq('isValidEmail "a@b.co"', isValidEmail("a@b.co"), true);
  eq('isValidEmail "a b@c.co"', isValidEmail("a b@c.co"), false);
  eq('isValidEmail "abc"', isValidEmail("abc"), false);
  eq('isValidEmail "a@b"', isValidEmail("a@b"), false);

  // ------------------------------------------------------------------
  section("clock: centralToUtc, buildSlots, openSlots");
  const now = new Date("2026-10-04T23:30:00Z"); // Sunday evening in Chicago
  eq("centralToUtc CDT 2026-10-05 09:00", centralToUtc(2026, 10, 5, 9, 0).toISOString(), "2026-10-05T14:00:00.000Z");
  eq("centralToUtc CST 2026-11-02 09:00", centralToUtc(2026, 11, 2, 9, 0).toISOString(), "2026-11-02T15:00:00.000Z");
  const visits = buildSlots("service_visit", now);
  eq("service_visit: 6 slots", visits.length, 6);
  eq("service_visit: first label", visits[0].label, "Mon Oct 5, 9-11 AM");
  eq("service_visit: first start", visits[0].start, "2026-10-05T14:00:00.000Z");
  eq("service_visit: first end", visits[0].end, "2026-10-05T16:00:00.000Z");
  check("service_visit: no weekend labels", !visits.some((s) => /^(Sat|Sun) /.test(s.label)), visits.map((s) => s.label));
  const calls = buildSlots("phone_call", now);
  eq("phone_call: 6 slots", calls.length, 6);
  eq("phone_call: first label", calls[0].label, "Mon Oct 5, 10:00 AM");
  eq("phone_call: first start", calls[0].start, "2026-10-05T15:00:00.000Z");
  eq("phone_call: first end", calls[0].end, "2026-10-05T15:30:00.000Z");
  const friday = buildSlots("service_visit", new Date("2026-10-30T20:00:00Z"));
  eq("Friday now: first slot is Mon Nov 2 (CST)", friday[0].start, "2026-11-02T15:00:00.000Z");
  eq("Friday now: first slot label", friday[0].label, "Mon Nov 2, 9-11 AM");
  const remaining = openSlots(visits, ["2026-10-05T14:00:00Z"]);
  eq("openSlots: a booked start given without milliseconds removes exactly one", remaining.length, 5);
  check("openSlots: the booked slot is the one removed", !remaining.some((s) => s.start === "2026-10-05T14:00:00.000Z"), remaining.map((s) => s.start));

  // ------------------------------------------------------------------
  section("emails: templates");
  const base = { kindLabel: "service visit", slotLabel: "Mon Oct 5, 9-11 AM", customerName: "Sam", businessName: "Dev Test Shop" };
  check('bookingCustomerEmail isDemo true contains "No technician will be sent"', bookingCustomerEmail({ ...base, isDemo: true }).text.includes("No technician will be sent"));
  check('bookingCustomerEmail isDemo false omits "No technician will be sent"', !bookingCustomerEmail({ ...base, isDemo: false }).text.includes("No technician will be sent"));
  const esc = escalationOwnerEmail({ urgency: "emergency", reason: "r", summary: "s", customerPhone: "+15555550100", businessName: "Dev Test Shop" });
  check('escalationOwnerEmail subject starts with "[EMERGENCY]"', esc.subject.startsWith("[EMERGENCY]"), esc.subject);

  // ------------------------------------------------------------------
  section("tools, onfile, prompt, notify");
  eq("TOOL_DEFINITIONS names", TOOL_DEFINITIONS.map((t) => t.name), [
    "get_available_slots", "check_service_area", "save_customer_details", "book_appointment", "escalate_to_owner",
  ]);
  for (const tool of TOOL_DEFINITIONS) {
    const s = tool.input_schema as { type?: unknown; required?: unknown };
    check(`${tool.name}: object input_schema with required array`, s.type === "object" && Array.isArray(s.required), s);
  }

  const ctx = {
    supabase: {} as never,
    businessId: "b",
    conversationId: "c",
    leadId: "l",
    customerNumber: "+15555550100",
    profile: { service_zip_prefixes: ["750"] },
    now,
  } as ToolContext;

  let threw = false;
  let unknown: Awaited<ReturnType<typeof executeTool>> | null = null;
  try {
    unknown = await executeTool("nope", {}, ctx);
  } catch {
    threw = true;
  }
  check("executeTool unknown tool: no throw", !threw);
  check("executeTool unknown tool: ok false", unknown?.ok === false, unknown);
  const inArea = await executeTool("check_service_area", { zip: "Dallas 75043" }, ctx);
  check('check_service_area "Dallas 75043": ok true, in_area true', inArea.ok === true && inArea.result.in_area === true, inArea);
  const outOfArea = await executeTool("check_service_area", { zip: "90210" }, ctx);
  check('check_service_area "90210": ok true, in_area false', outOfArea.ok === true && outOfArea.result.in_area === false, outOfArea);
  const badZip = await executeTool("check_service_area", { zip: "12" }, ctx);
  check('check_service_area "12": ok false', badZip.ok === false, badZip);

  eq("formatOnFile empty", formatOnFile({ customer: null, location: null, zip: null, appointments: [] }), "- Nothing on file yet.");

  // An unconfirmed customer (found only by phone) shows its name and nothing
  // else, even if a caller passes an address, email and appointment along.
  const appointment = { id: "a1", kind: "service_visit" as const, start: "2026-10-05T14:00:00.000Z", label: "Mon Oct 5, 9-11 AM", status: "scheduled" };
  const unconfirmedText = formatOnFile({
    customer: { id: "c1", name: "Pat Lee", email: "pat@example.com", confirmed: false },
    location: { id: "l1", address: "7 Pine St, 75043" },
    zip: "75043",
    appointments: [appointment],
  });
  eq("formatOnFile unconfirmed: one name line, labelled", unconfirmedText, "- Name (from an earlier conversation, not yet confirmed): Pat Lee");
  check("formatOnFile unconfirmed: no email, address or appointment", !/pat@example|Pine|75043|Appointment/.test(unconfirmedText), unconfirmedText);
  eq(
    "formatOnFile unconfirmed: a name with line breaks is flattened to one line",
    formatOnFile({ customer: { id: "c1", name: "Pat\n- Address: x   Lee", email: null, confirmed: false }, location: null, zip: null, appointments: [] }),
    "- Name (from an earlier conversation, not yet confirmed): Pat - Address: x Lee",
  );
  eq(
    "formatOnFile confirmed: name, address, email and appointment lines",
    formatOnFile({
      customer: { id: "c1", name: "Pat Lee", email: "pat@example.com", confirmed: true },
      location: { id: "l1", address: "7 Pine St, 75043" },
      zip: "75043",
      appointments: [appointment],
    }),
    "- Name: Pat Lee\n- Address: 7 Pine St, 75043\n- Email: pat@example.com\n- Appointment: service visit, Mon Oct 5, 9-11 AM (scheduled)",
  );

  // confirmation_email, in the order confirmationOutcome decides it.
  const outcome = (requested: boolean, appointments: number, results: ("logged" | "sent" | "failed")[], lookupFailed = false) =>
    confirmationOutcome({ requested, appointments, results, lookupFailed });
  eq("confirmationOutcome: no email in the call -> not_requested", outcome(false, 2, ["sent"]), "not_requested");
  eq("confirmationOutcome: lookup error -> failed", outcome(true, 1, [], true), "failed");
  eq("confirmationOutcome: no email in the call -> not_requested even if a lookup failed", outcome(false, 1, [], true), "not_requested");
  eq("confirmationOutcome: no scheduled appointments -> no_bookings", outcome(true, 0, []), "no_bookings");
  eq("confirmationOutcome: all already confirmed -> already_sent", outcome(true, 2, []), "already_sent");
  eq("confirmationOutcome: one logged -> logged", outcome(true, 1, ["logged"]), "logged");
  eq("confirmationOutcome: one sent -> sent", outcome(true, 1, ["sent"]), "sent");
  eq("confirmationOutcome: sent and logged -> sent", outcome(true, 2, ["logged", "sent"]), "sent");
  eq("confirmationOutcome: delivery failed -> failed", outcome(true, 1, ["failed"]), "failed");
  eq("confirmationOutcome: one sent, one failed -> failed (the failed one is retried next save)", outcome(true, 2, ["sent", "failed"]), "failed");

  const demoPrompt = buildSystemPrompt({ display_name: "Dev Test Shop", is_demo: true }, "- Nothing on file yet.", now);
  const realPrompt = buildSystemPrompt({ display_name: "Real Shop", is_demo: false }, "- Nothing on file yet.", now);
  check('prompt contains "On file for this customer:"', demoPrompt.includes("On file for this customer:"));
  check('prompt contains "check_service_area"', demoPrompt.includes("check_service_area"));
  check('demo prompt contains "demo booking"', demoPrompt.includes("demo booking"));
  check('non-demo prompt does NOT contain "demo booking"', !realPrompt.includes("demo booking"));
  check('prompt tells the agent what to do with a "not yet confirmed" name', demoPrompt.includes('marked "not yet confirmed"') && demoPrompt.includes("Am I speaking with"), demoPrompt);
  check(
    "prompt covers every confirmation_email value",
    ["sent", "logged", "already_sent", "no_bookings", "not_requested", "failed"].every((value) => demoPrompt.includes(`"${value}"`)) &&
      demoPrompt.includes("unless the value is \"failed\""),
  );
  check('prompt says an email on file is not permission ("no_consent")', demoPrompt.includes('"no_consent"') && demoPrompt.includes("An email on file is not permission"));

  const inserts: { table: string; row: Record<string, unknown> }[] = [];
  const fakeSupabase = {
    from(table: string) {
      return {
        insert(row: Record<string, unknown>) {
          inserts.push({ table, row });
          return Promise.resolve({ error: null });
        },
      };
    },
  };
  const sent = await sendEmail(fakeSupabase as never, {
    businessId: "b",
    conversationId: "c",
    leadId: "l",
    appointmentId: null,
    audience: "owner",
    to: "owner@example.com",
    template: "booking_owner",
    subject: "s",
    text: "t",
  });
  eq('sendEmail log mode returns status "logged"', sent.status, "logged");
  eq("sendEmail log mode: exactly one insert", inserts.length, 1);
  check('sendEmail log mode: insert is a notifications row with status "logged"', inserts[0]?.table === "notifications" && inserts[0]?.row.status === "logged", inserts[0]);
  eq("sendEmail log mode: fetch never called", fetchCalls, 0);

  // ------------------------------------------------------------------
  console.log(`\nTotal: ${passed + failed} cases, ${passed} passed, ${failed} failed`);
  console.log(failed === 0 ? "ALL PASS" : "SOME FAILED");
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.log("unit tests aborted:", err instanceof Error ? err.stack : String(err));
  process.exit(2);
});
