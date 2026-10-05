/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from "node:fs";
import path from "node:path";
import { CUSTOMER_MODEL, simulateCustomerReply, type TranscriptTurn } from "./customer";
import { FakeSupabase, readAllTables, seed } from "./fakeSupabase";
import {
  BASE_PROFILE,
  BUSINESS_NAME,
  BUSINESS_NUMBER,
  CUSTOMER_NUMBER,
  SCENARIOS,
  isSimulated,
  type Ended,
  type Scenario,
  type ToolCallTrace,
  type Trace,
  type TurnTrace,
} from "./scenarios";

// ---------------------------------------------------------------------------
// Safety first, before any agent module is loaded. The agent modules read
// these two settings when they are imported, and .env.local (loaded by
// `--env-file`) may say "send". Nothing real is ever sent: texts and emails
// are only logged, and the only outbound request allowed is to Anthropic.
// Both the agent's model and the simulated customer's model use this fence.
// ---------------------------------------------------------------------------
process.env.EMAIL_MODE = "log";
process.env.OUTBOUND_MODE = "log";

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  let host = "";
  try {
    host = new URL(url).host;
  } catch {
    // unparseable: treated as not allowed
  }
  if (host !== "api.anthropic.com") {
    throw new Error(`eval: blocked outbound request to ${host || "(unparseable url)"}`);
  }
  return realFetch(input, init);
}) as typeof fetch;

const OPT_IN_PREFIX = "Fieldworx Demo: Thanks for texting the Fieldworx Demo AI assistant.";

type CheckResult = { description: string; passed: boolean };
type RunResult = {
  run: number;
  passed: boolean;
  checks: CheckResult[];
  ms: number;
  inputTokens: number; // the agent's own tokens; the simulated customer's are not counted
  outputTokens: number;
  turnsUsed: number; // customer texts sent to the agent
  ended: Ended;
  trace: Trace;
};
type ScenarioRuns = { scenario: Scenario; runs: RunResult[] };

// Never let a key-shaped string reach the console or the trace file.
function redact(text: string): string {
  return text.replace(/sk-[A-Za-z0-9_-]{8,}/g, "[redacted]");
}

function numberArg(name: string, fallback: number): number {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!arg) return fallback;
  const value = Number(arg.slice(name.length + 3));
  if (!Number.isInteger(value) || value < 1) {
    console.error(`--${name} must be a whole number of at least 1`);
    process.exit(2);
  }
  return value;
}

async function main() {
  const onlyArg = process.argv.find((a) => a.startsWith("--only="));
  const only = onlyArg ? onlyArg.slice("--only=".length) : null;
  const repeat = numberArg("repeat", 1);
  const selected = only ? SCENARIOS.filter((s) => s.id === only) : SCENARIOS;
  if (selected.length === 0) {
    console.error(`No scenario with id "${only}". Available: ${SCENARIOS.map((s) => s.id).join(", ")}`);
    process.exit(2);
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY is not set (expected from .env.local via --env-file).");
    process.exit(2);
  }

  const config = await import("../../src/lib/agent/config");
  if (config.EMAIL_MODE !== "log" || config.OUTBOUND_MODE !== "log") {
    console.error("Refusing to run: EMAIL_MODE and OUTBOUND_MODE must both be \"log\".");
    process.exit(2);
  }
  const { processInbound } = await import("../../src/lib/agent/run");
  const { stripForHistory } = await import("../../src/lib/agent/format");
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ timeout: config.CLAUDE_TIMEOUT_MS, maxRetries: 1 });

  async function runOnce(scenario: Scenario, run: number): Promise<RunResult> {
    const db = new FakeSupabase();
    const business = seed(db, "businesses", { name: BUSINESS_NAME, agent_profile: BASE_PROFILE });
    const lead = seed(db, "leads", {
      business_id: business.id,
      customer_id: null,
      work_order_id: null,
      urgency: null,
    });
    if (scenario.seed) {
      const { name, email, location } = scenario.seed.customer;
      const customer = seed(db, "customers", {
        business_id: business.id,
        name,
        phone: CUSTOMER_NUMBER,
        email,
        source: "agent_inbound",
      });
      if (location) {
        seed(db, "service_locations", {
          business_id: business.id,
          customer_id: customer.id,
          address: location,
        });
      }
      lead.customer_id = customer.id;
    }
    const conversation = seed(db, "conversations", {
      business_id: business.id,
      lead_id: lead.id,
      channel: "sms",
      customer_number: CUSTOMER_NUMBER,
      business_number: BUSINESS_NUMBER,
      status: "active",
    });

    const turns: TurnTrace[] = [];
    const started = Date.now();

    // One customer text in, one agent run, one recorded turn out.
    async function sendTurn(text: string): Promise<TurnTrace> {
      const inbound = seed(db, "messages", {
        business_id: business.id,
        conversation_id: conversation.id,
        direction: "inbound",
        body: text,
        twilio_sid: `SMeval${scenario.id}r${run}x${turns.length}`,
      });
      const outboundBefore = db.tables.messages.filter((m) => m.direction === "outbound").length;

      // The agent's own log lines are kept with the turn instead of printed.
      const logs: string[] = [];
      const original = { log: console.log, error: console.error, warn: console.warn };
      const capture = (...args: unknown[]) => {
        logs.push(
          redact(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")),
        );
      };
      console.log = capture;
      console.error = capture;
      console.warn = capture;
      try {
        await processInbound(
          {
            businessId: business.id,
            conversationId: conversation.id,
            inboundMessageId: inbound.id,
            leadId: lead.id,
            customerNumber: CUSTOMER_NUMBER,
            businessNumber: BUSINESS_NUMBER,
            inboundBody: text,
            conversationIsNew: turns.length === 0,
            receivedAt: Date.now(),
          },
          { supabase: db as never, anthropic: client },
        );
      } finally {
        console.log = original.log;
        console.error = original.error;
        console.warn = original.warn;
      }

      const agentRun = db.tables.agent_runs.find((r) => r.inbound_message_id === inbound.id);
      const newOutbound = db.tables.messages
        .filter((m) => m.direction === "outbound")
        .slice(outboundBefore)
        .filter((m) => !String(m.body ?? "").startsWith(OPT_IN_PREFIX));
      const replyRaw: string | null = newOutbound.length > 0 ? newOutbound.at(-1)!.body : null;

      const turn: TurnTrace = {
        customer: text,
        replyRaw,
        reply: replyRaw === null ? null : stripForHistory(replyRaw, BASE_PROFILE.program_prefix),
        outcome: agentRun?.outcome ?? null,
        errorCode: agentRun?.error_code ?? null,
        toolCalls: ((agentRun?.tool_calls ?? []) as ToolCallTrace[]).map((c) => ({
          name: c.name,
          ok: c.ok,
          wrote: c.wrote,
          ms: c.ms,
          input: c.input,
          result: c.result,
        })),
        inputTokens: agentRun?.input_tokens ?? null,
        outputTokens: agentRun?.output_tokens ?? null,
        modelLatencyMs: agentRun?.model_latency_ms ?? null,
        totalLatencyMs: agentRun?.total_latency_ms ?? null,
        customerNext: null,
        logs,
      };
      turns.push(turn);
      return turn;
    }

    let ended: Ended;
    if (isSimulated(scenario)) {
      // Open with the scripted text; after each agent reply ask the simulated
      // customer what it says next. DONE (not sent to the agent) or the turn
      // limit ends it. An agent with no reply, or a customer with no text,
      // ends it too ("no_reply").
      ended = "max_turns";
      const transcript: TranscriptTurn[] = [];
      let customerText = scenario.opening;
      for (let n = 1; n <= scenario.maxTurns; n++) {
        const turn = await sendTurn(customerText);
        if (turn.reply === null) {
          ended = "no_reply";
          break;
        }
        transcript.push({ from: "customer", text: customerText }, { from: "agent", text: turn.reply });
        const next = await simulateCustomerReply(client, scenario.persona, transcript);
        turn.customerNext = next;
        if (next === "DONE") {
          ended = "done";
          break;
        }
        if (next === "") {
          ended = "no_reply";
          break;
        }
        customerText = next;
      }
    } else {
      for (const text of scenario.turns) await sendTurn(text);
      ended = "scripted";
    }

    const trace: Trace = { turns, ended, tables: readAllTables(db) };
    const checks: CheckResult[] = scenario.checks.map((check) => {
      try {
        return { description: check.description, passed: check.test(trace) };
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return { description: `${check.description} (check threw: ${redact(reason)})`, passed: false };
      }
    });

    return {
      run,
      passed: checks.every((c) => c.passed),
      checks,
      ms: Date.now() - started,
      inputTokens: turns.reduce((n, t) => n + (t.inputTokens ?? 0), 0),
      outputTokens: turns.reduce((n, t) => n + (t.outputTokens ?? 0), 0),
      turnsUsed: turns.length,
      ended,
      trace,
    };
  }

  const startedAt = new Date();
  const all: ScenarioRuns[] = [];
  for (const scenario of selected) {
    const runs: RunResult[] = [];
    for (let k = 1; k <= repeat; k++) {
      process.stdout.write(`running ${scenario.id} ${scenario.title} (run ${k}/${repeat}) ... `);
      try {
        const result = await runOnce(scenario, k);
        runs.push(result);
        console.log(`${result.passed ? "PASS" : "FAIL"} (${result.turnsUsed} turns, ended: ${result.ended})`);
      } catch (err) {
        const reason = redact(err instanceof Error ? err.message : String(err));
        console.log("FAIL (run threw)");
        runs.push({
          run: k,
          passed: false,
          checks: [{ description: `run threw: ${reason}`, passed: false }],
          ms: 0,
          inputTokens: 0,
          outputTokens: 0,
          turnsUsed: 0,
          ended: "no_reply",
          trace: { turns: [], ended: "no_reply", tables: {} },
        });
      }
    }
    all.push({ scenario, runs });
  }

  // ---- summary table: one row per scenario across its runs ----
  const sum = (runs: RunResult[], pick: (r: RunResult) => number) =>
    runs.reduce((n, r) => n + pick(r), 0);
  const rows = all.map(({ scenario, runs }) => {
    const failedCounts = new Map<string, number>();
    for (const r of runs) {
      for (const c of r.checks) {
        if (!c.passed) failedCounts.set(c.description, (failedCounts.get(c.description) ?? 0) + 1);
      }
    }
    const failed =
      Array.from(failedCounts.entries())
        .map(([d, n]) => (repeat > 1 ? `${d} (${n}/${repeat} runs)` : d))
        .join("; ") || "-";
    return {
      id: scenario.id,
      title: scenario.title,
      passed: `${runs.filter((r) => r.passed).length}/${runs.length}`,
      turns: runs.map((r) => r.turnsUsed).join(","),
      ms: String(sum(runs, (r) => r.ms)),
      tokens: `${sum(runs, (r) => r.inputTokens)}/${sum(runs, (r) => r.outputTokens)}`,
      failed,
    };
  });
  const header = {
    id: "ID",
    title: "Scenario",
    passed: "Passed",
    turns: "Turns per run",
    ms: "Total ms",
    tokens: "Agent tokens in/out",
    failed: "Failed checks",
  };
  const keys = Object.keys(header) as (keyof typeof header)[];
  const widths = keys.map((k) => Math.max(header[k].length, ...rows.map((r) => r[k].length)));
  const line = (r: typeof header) =>
    keys.map((k, i) => (k === "failed" ? r[k] : r[k].padEnd(widths[i]))).join("  ");
  console.log("");
  console.log(line(header));
  console.log(keys.map((k, i) => (k === "failed" ? "-".repeat(13) : "-".repeat(widths[i]))).join("  "));
  for (const r of rows) console.log(line(r));

  const allRuns = all.flatMap((s) => s.runs);
  const passedRuns = allRuns.filter((r) => r.passed).length;
  console.log("");
  console.log(
    `Total: ${all.length} scenarios x ${repeat} run${repeat === 1 ? "" : "s"} = ${allRuns.length} runs, ${passedRuns} passed, ${allRuns.length - passedRuns} failed, ` +
      `${sum(allRuns, (r) => r.ms)} ms, ${sum(allRuns, (r) => r.inputTokens)}/${sum(allRuns, (r) => r.outputTokens)} agent tokens in/out`,
  );

  // ---- one failing run per scenario, turn by turn ----
  for (const { scenario, runs } of all) {
    const failing = runs.find((r) => !r.passed);
    if (!failing) continue;
    console.log("");
    console.log(
      `=== FAIL ${scenario.id} ${scenario.title}: run ${failing.run} of ${runs.length} (${failing.turnsUsed} turns, ended: ${failing.ended}) ===`,
    );
    for (const c of failing.checks.filter((x) => !x.passed)) console.log(`failed check: ${c.description}`);
    failing.trace.turns.forEach((t, i) => {
      console.log(`-- turn ${i + 1}`);
      console.log(`customer: ${t.customer}`);
      console.log(`reply:    ${t.replyRaw ?? "(none sent)"}`);
      console.log(
        `outcome:  ${t.outcome ?? "(no run row)"}${t.errorCode ? `  error_code=${t.errorCode}` : ""}  tokens=${t.inputTokens ?? "-"}/${t.outputTokens ?? "-"}  total=${t.totalLatencyMs ?? "-"}ms`,
      );
      for (const call of t.toolCalls) {
        console.log(
          `  tool ${call.name} ${call.ok ? "ok" : "FAILED"}${call.wrote ? " wrote" : ""} ${call.ms}ms input=${JSON.stringify(call.input)}`,
        );
        if (!call.ok) console.log(`       result=${call.result}`);
      }
      for (const l of t.logs.filter((x) => !x.startsWith("[agent] run complete"))) console.log(`  log: ${l}`);
      if (t.customerNext !== null) console.log(`simulated customer next: ${t.customerNext}`);
    });
  }

  // ---- full trace file ----
  const outDir = path.resolve("scripts", "eval", "out");
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${startedAt.toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        startedAt: startedAt.toISOString(),
        agentModel: config.AGENT_MODEL,
        customerModel: CUSTOMER_MODEL,
        repeat,
        scenarios: all.map(({ scenario, runs }) => ({
          id: scenario.id,
          title: scenario.title,
          mode: isSimulated(scenario) ? "simulated" : "scripted",
          runs: runs.map((r) => ({
            run: r.run,
            passed: r.passed,
            checks: r.checks,
            ms: r.ms,
            inputTokens: r.inputTokens,
            outputTokens: r.outputTokens,
            turnsUsed: r.turnsUsed,
            ended: r.ended,
            turns: r.trace.turns,
            tables: r.trace.tables,
          })),
        })),
      },
      null,
      2,
    ),
  );
  console.log("");
  console.log(`Trace written to ${path.relative(process.cwd(), file)}`);

  process.exit(passedRuns === allRuns.length ? 0 : 1);
}

main().catch((err) => {
  console.error("eval aborted:", redact(err instanceof Error ? (err.stack ?? err.message) : String(err)));
  process.exit(2);
});
