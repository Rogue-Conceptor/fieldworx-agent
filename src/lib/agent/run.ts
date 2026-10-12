import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  AGENT_EFFORT,
  AGENT_MODEL,
  CLAUDE_TIMEOUT_MS,
  MAX_TOKENS,
  MAX_TOOL_ROUNDS,
  OUTBOUND_MODE,
  RUN_DEADLINE_MS,
} from "./config";
import type { SlotKind } from "./clock";
import { kindLabel } from "./emails";
import { formatOutbound, formatOutboundWithInfo } from "./format";
import { loadHistory } from "./history";
import {
  classifyInbound,
  FALLBACK_TEXT,
  OPT_IN_TEXT,
  SAFETY_TEXT,
} from "./keywords";
import { formatOnFile, loadOnFile } from "./onfile";
import {
  isOptedOut,
  recordOptStatus,
  type OptSource,
  type OptStatus,
} from "./optstatus";
import { buildSystemPrompt, type AgentProfile } from "./prompt";
import { sendOutbound } from "./send";
import { executeTool, TOOL_DEFINITIONS, type ToolContext } from "./tools";

type Outcome =
  | "replied"
  | "fallback"
  | "skipped_keyword"
  | "skipped_opted_out"
  | "safety"
  | "superseded"
  | "send_failed"
  | "error";

type Admin = ReturnType<typeof createAdminClient>;

interface ProcessInboundArgs {
  businessId: string;
  conversationId: string;
  inboundMessageId: string;
  leadId: string;
  customerNumber: string;
  businessNumber: string;
  inboundBody: string;
  conversationIsNew: boolean;
  receivedAt: number;
}

// One entry per tool the model called, stored on the agent_runs row. `result`
// is the JSON the model saw, cut to TOOL_RESULT_MAX characters.
type ToolCallRecord = {
  name: string;
  ok: boolean;
  wrote: boolean;
  ms: number;
  input: unknown;
  result: string;
};

const TOOL_RESULT_MAX = 500;

type RunFields = {
  outcome: Outcome;
  keyword?: string | null;
  outbound_message_id?: string | null;
  model?: string | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  model_latency_ms?: number | null;
  error_code?: string | null;
  tool_calls?: ToolCallRecord[];
};

// Mask anything phone-shaped so error text can never leak a full number.
function maskPhones(text: string): string {
  return text.replace(/\+?\d[\d\s().-]{5,}\d/g, (m) => "***" + m.slice(-4));
}

// Short, log-safe label for an error, masked and capped at 120 characters.
// Anthropic API errors carry a body: "status:type:message". Anything else is
// the class name (plus status/code when it has one) or the message.
function shortError(err: unknown): string {
  if (typeof err === "object" && err !== null) {
    const api = err as {
      status?: unknown;
      error?: { error?: { type?: unknown; message?: unknown } };
    };
    const apiType = api.error?.error?.type;
    const apiMessage = api.error?.error?.message;
    if (apiType !== undefined || apiMessage !== undefined) {
      const full = `${api.status ?? ""}:${apiType ?? ""}:${apiMessage ?? ""}`;
      return maskPhones(full).slice(0, 120);
    }
  }
  if (err instanceof Error) {
    const e = err as Error & { status?: unknown; code?: unknown };
    const name = err.constructor?.name || err.name;
    const label = name && name !== "Error" ? name : err.message;
    const detail = e.status ?? e.code;
    const full = detail !== undefined && detail !== null ? `${label}:${String(detail)}` : label;
    return maskPhones(full).slice(0, 120);
  }
  return maskPhones(String(err)).slice(0, 120);
}

// Twilio error code if present, else a short message.
function sendErrorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "number" || (typeof code === "string" && code !== "")) {
    return String(code);
  }
  const message = err instanceof Error ? err.message : String(err);
  return maskPhones(message).slice(0, 120);
}

// Twilio refuses a send to a number that has opted out of this sender.
const TWILIO_OPTED_OUT_CODE = 21610;

function isTwilioOptedOut(err: unknown): boolean {
  return Number((err as { code?: unknown } | null)?.code) === TWILIO_OPTED_OUT_CODE;
}

// Best effort: a failure is logged with a fixed string and never changes what
// the run does next.
async function tryRecordOptStatus(
  supabase: Admin,
  a: ProcessInboundArgs,
  status: OptStatus,
  keyword: string | null,
  source: OptSource,
): Promise<void> {
  try {
    await recordOptStatus(supabase, a.businessId, a.customerNumber, status, keyword, source);
  } catch {
    console.error("[agent] opt status record failed");
  }
}

// Inserts one agent_runs row and returns the total latency it recorded.
async function recordRun(
  supabase: Admin,
  a: ProcessInboundArgs,
  row: RunFields,
): Promise<number> {
  const totalLatencyMs = Date.now() - a.receivedAt;
  const { error } = await supabase.from("agent_runs").insert({
    business_id: a.businessId,
    conversation_id: a.conversationId,
    inbound_message_id: a.inboundMessageId,
    outbound_message_id: null,
    outbound_mode: OUTBOUND_MODE,
    model: null,
    input_tokens: null,
    output_tokens: null,
    model_latency_ms: null,
    total_latency_ms: totalLatencyMs,
    error_code: null,
    keyword: null,
    tool_calls: [],
    ...row,
  });
  if (error) throw error;
  return totalLatencyMs;
}

// Tool names and ok flags only: never inputs, results, or anything the
// customer said.
function logRun(
  outcome: Outcome,
  conversationId: string,
  totalLatencyMs: number,
  toolCalls: ToolCallRecord[] = [],
) {
  console.log("[agent] run complete", {
    outcome,
    conversation_id: conversationId,
    mode: OUTBOUND_MODE,
    total_latency_ms: totalLatencyMs,
    tools: toolCalls.map((call) => ({ name: call.name, ok: call.ok })),
  });
}

// Built from the booking records, not the model, for when a booking succeeded
// but the run then failed before the model could write the confirmation.
function bookingConfirmation(
  bookings: { kind: SlotKind; label: string }[],
  isDemo: boolean,
): string {
  const parts = bookings.map((b) => {
    const kind = kindLabel(b.kind);
    const article = /^[aeiou]/i.test(kind) ? "an" : "a";
    return `You're booked for ${article} ${kind}, ${b.label}.`;
  });
  if (isDemo) {
    parts.push("This is a demo booking, so no technician will actually come.");
  }
  return parts.join(" ");
}

// Never throws: any unexpected failure is logged (masked) and recorded as an
// "error" run when possible. `deps` lets a test inject its own clients and
// listen for events; left out, the real clients are used and events are ignored.
// `send` replaces sendOutbound, so a test can make a text fail the way Twilio
// does (sendOutbound itself never throws in log mode).
export async function processInbound(
  a: ProcessInboundArgs,
  deps?: {
    supabase?: Admin;
    anthropic?: Pick<Anthropic, "messages">;
    send?: typeof sendOutbound;
    onEvent?: (e: {
      type: "question_trimmed";
      reason: "extra_question" | "compound_question";
      dropped: number;
    }) => void;
  },
): Promise<void> {
  // Declared outside the try so an error run still records the tools that ran.
  const toolCalls: ToolCallRecord[] = [];
  try {
    const supabase = deps?.supabase ?? createAdminClient();
    const send = deps?.send ?? sendOutbound;

    // 1. business profile -> reply prefix
    const { data: business, error: profileError } = await supabase
      .from("businesses")
      .select("agent_profile")
      .eq("id", a.businessId)
      .maybeSingle();
    if (profileError) throw profileError;
    const profile = (business?.agent_profile ?? {}) as AgentProfile;
    const prefix =
      profile.program_prefix ?? `${profile.display_name ?? "Message"}:`;

    // 2. carrier keywords get no reply. STOP-type words and START-type words
    // are also recorded per number; HELP is not.
    const inbound = classifyInbound(a.inboundBody);
    if (
      inbound.kind === "opt_out" ||
      inbound.kind === "opt_in" ||
      inbound.kind === "help"
    ) {
      if (inbound.kind !== "help") {
        await tryRecordOptStatus(
          supabase,
          a,
          inbound.kind === "opt_out" ? "opted_out" : "opted_in",
          inbound.keyword,
          "keyword",
        );
      }
      const total = await recordRun(supabase, a, {
        outcome: "skipped_keyword",
        keyword: inbound.keyword,
      });
      logRun("skipped_keyword", a.conversationId, total);
      return;
    }
    const kind = inbound.kind; // "safety" skips the model

    // 2a. a number that opted out gets nothing: no opt-in text, no model, no
    // tools. If the check itself fails the answer is unknown, and an unknown
    // answer is treated as opted out: nothing is ever sent on a failed check.
    let optedOut: boolean;
    let optCheckFailed = false;
    try {
      optedOut = await isOptedOut(supabase, a.businessId, a.customerNumber);
    } catch {
      console.error("[agent] opt-out check failed");
      optedOut = true;
      optCheckFailed = true;
    }
    if (optedOut) {
      const total = await recordRun(supabase, a, {
        outcome: "skipped_opted_out",
        error_code: optCheckFailed ? "opt_check_failed" : null,
      });
      logRun("skipped_opted_out", a.conversationId, total);
      return;
    }

    // 2b. first text of a new conversation: opt-in confirmation, sent exactly
    // as written (not through formatOutbound) and with no agent_runs row of
    // its own. A failure here must not block the agent's reply, except Twilio
    // refusing the number as opted out (21610): that ends the run.
    if (a.conversationIsNew) {
      try {
        const sent = await send({
          to: a.customerNumber,
          from: a.businessNumber,
          body: OPT_IN_TEXT,
        });
        const { error: optInStoreError } = await supabase
          .from("messages")
          .insert({
            business_id: a.businessId,
            conversation_id: a.conversationId,
            direction: "outbound",
            body: OPT_IN_TEXT,
            twilio_sid: sent.sid,
          });
        if (optInStoreError) throw optInStoreError;
      } catch (err) {
        // sendErrorCode keeps Twilio's numeric code (shortError shows the HTTP
        // status instead).
        console.error("[agent] opt-in confirmation failed", sendErrorCode(err));
        if (isTwilioOptedOut(err)) {
          await tryRecordOptStatus(supabase, a, "opted_out", null, "twilio_21610");
          // The number is opted out, so no reply could reach it: no model, no
          // tools, no reply send.
          const total = await recordRun(supabase, a, {
            outcome: "skipped_opted_out",
            error_code: String(TWILIO_OPTED_OUT_CODE),
          });
          logRun("skipped_opted_out", a.conversationId, total);
          return;
        }
      }
    }

    let outcome: Outcome;
    let replyText: string;
    let model: string | null = null;
    let inputTokens: number | null = null;
    let outputTokens: number | null = null;
    let modelLatencyMs: number | null = null;
    let errorCode: string | null = null;

    if (kind === "safety") {
      replyText = formatOutbound(SAFETY_TEXT, prefix);
      outcome = "safety";
    } else {
      // 3. ask the model
      const history = await loadHistory(supabase, a.conversationId, prefix);
      let modelText = "";
      let failure: string | null = null;
      // Every successful booking this run, for the code-built confirmation.
      const bookings: { kind: SlotKind; label: string }[] = [];
      const pastDeadline = () => Date.now() - a.receivedAt > RUN_DEADLINE_MS;

      if (history.length === 0) {
        failure = "empty_history";
      } else {
        model = AGENT_MODEL;
        const onFile = await loadOnFile(supabase, {
          businessId: a.businessId,
          leadId: a.leadId,
          customerNumber: a.customerNumber,
        });
        const system = buildSystemPrompt(profile, formatOnFile(onFile));
        const anthropic =
          deps?.anthropic ??
          new Anthropic({
            timeout: CLAUDE_TIMEOUT_MS,
            maxRetries: 1,
          });
        // Business, number, conversation and lead come from this inbound
        // message, never from the model.
        const toolContext: ToolContext = {
          supabase,
          businessId: a.businessId,
          conversationId: a.conversationId,
          leadId: a.leadId,
          customerNumber: a.customerNumber,
          profile,
          now: new Date(),
        };
        const messages: Anthropic.MessageParam[] = [...history];
        inputTokens = 0;
        outputTokens = 0;
        modelLatencyMs = 0;

        // At most MAX_TOOL_ROUNDS rounds of tool calls, then one more model
        // call that has to produce the reply.
        for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
          // The call gets what is left of the run's budget, minus 2 s so the
          // reply can still be stored and sent. With under 10 s of call time
          // left (remaining minus that 2 s) there is no time for a retry.
          const remaining = RUN_DEADLINE_MS - (Date.now() - a.receivedAt);
          if (remaining - 2000 <= 0) {
            failure = "deadline";
            break;
          }
          const started = Date.now();
          let response: Anthropic.Message;
          try {
            response = await anthropic.messages.create(
              {
                model: AGENT_MODEL,
                max_tokens: MAX_TOKENS,
                thinking: { type: "adaptive" },
                output_config: { effort: AGENT_EFFORT },
                system,
                tools: TOOL_DEFINITIONS,
                messages,
              },
              {
                timeout: Math.min(CLAUDE_TIMEOUT_MS, remaining - 2000),
                maxRetries: remaining - 2000 < 10000 ? 0 : 1,
              },
            );
          } catch (err) {
            modelLatencyMs += Date.now() - started;
            failure = shortError(err);
            break;
          }
          modelLatencyMs += Date.now() - started;
          inputTokens += response.usage.input_tokens;
          outputTokens += response.usage.output_tokens;

          // Partial text is never sent: a cut-off reply is a failure.
          if (response.stop_reason === "max_tokens") {
            failure = "max_tokens";
            break;
          }

          if (response.stop_reason === "tool_use") {
            if (round === MAX_TOOL_ROUNDS) {
              failure = "tool_rounds_exceeded";
              break;
            }
            // The assistant turn goes back exactly as returned, thinking
            // blocks included: the API requires them unmodified with tools.
            messages.push({ role: "assistant", content: response.content });

            const results: Anthropic.ToolResultBlockParam[] = [];
            for (const block of response.content) {
              if (block.type !== "tool_use") continue;
              if (pastDeadline()) {
                failure = "deadline";
                break;
              }
              const toolStarted = Date.now();
              const outcome = await executeTool(block.name, block.input, toolContext);
              const resultJson = JSON.stringify(outcome.result);
              if (
                block.name === "book_appointment" &&
                outcome.ok &&
                typeof outcome.result.kind === "string" &&
                typeof outcome.result.label === "string"
              ) {
                bookings.push({
                  kind: outcome.result.kind as SlotKind,
                  label: outcome.result.label,
                });
              }
              toolCalls.push({
                name: block.name.slice(0, 64),
                ok: outcome.ok,
                wrote: outcome.wrote,
                ms: Date.now() - toolStarted,
                input: block.input,
                result: resultJson.slice(0, TOOL_RESULT_MAX),
              });
              results.push({
                type: "tool_result",
                tool_use_id: block.id,
                content: resultJson,
                is_error: !outcome.ok,
              });
            }
            if (failure !== null) break;
            if (results.length === 0) {
              failure = "empty_response";
              break;
            }
            messages.push({ role: "user", content: results });
            continue;
          }

          modelText = response.content
            .flatMap((block) => (block.type === "text" ? [block.text] : []))
            .join("")
            .trim();
          if (!modelText) failure = "empty_response";
          break;
        }
      }

      const wroteSomething = toolCalls.some((call) => call.ok && call.wrote);

      if (failure !== null) {
        errorCode = failure;
        if (bookings.length > 0) {
          // The customer is booked: confirm from the records, and leave the
          // lead as the booking left it.
          outcome = "replied";
          replyText = formatOutbound(
            bookingConfirmation(bookings, profile.is_demo === true),
            prefix,
          );
        } else {
          outcome = "fallback";
          replyText = formatOutbound(FALLBACK_TEXT, prefix);
          // No booking, so a person has to pick this up, even if other tools
          // (saved details, an alert) wrote along the way.
          const { error: escalateError } = await supabase
            .from("leads")
            .update({ status: "escalated" })
            .eq("id", a.leadId);
          if (escalateError) {
            console.error(
              "[agent] lead escalation failed",
              maskPhones(escalateError.message).slice(0, 120),
            );
          }
        }
      } else {
        outcome = "replied";
        // The one-question rule is enforced here, not just asked of the model.
        const formatted = formatOutboundWithInfo(modelText, prefix);
        replyText = formatted.body;
        if (formatted.questionsDropped > 0) {
          console.log(`[agent] trimmed ${formatted.questionsDropped} extra question(s)`);
          deps?.onEvent?.({
            type: "question_trimmed",
            reason: "extra_question",
            dropped: formatted.questionsDropped,
          });
        }
        if (formatted.compoundCut) {
          console.log("[agent] cut a compound question");
          deps?.onEvent?.({ type: "question_trimmed", reason: "compound_question", dropped: 1 });
        }
      }

      // 4. a newer inbound message means this reply is stale, unless a tool
      // already changed something (a booking, saved details, an alert): then
      // the customer must hear about it, so the reply always goes out.
      const { data: newest, error: newestError } = await supabase
        .from("messages")
        .select("id")
        .eq("conversation_id", a.conversationId)
        .eq("direction", "inbound")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (newestError) throw newestError;
      if (newest && newest.id !== a.inboundMessageId && !wroteSomething) {
        const total = await recordRun(supabase, a, {
          outcome: "superseded",
          model,
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          model_latency_ms: modelLatencyMs,
          tool_calls: toolCalls,
        });
        logRun("superseded", a.conversationId, total, toolCalls);
        return;
      }
    }

    // 5. send (or log) the reply
    let sid: string | null = null;
    let sendFailed = false;
    try {
      const sent = await send({
        to: a.customerNumber,
        from: a.businessNumber,
        body: replyText,
      });
      sid = sent.sid;
    } catch (err) {
      sendFailed = true;
      outcome = "send_failed";
      errorCode = sendErrorCode(err);
      if (isTwilioOptedOut(err)) {
        await tryRecordOptStatus(supabase, a, "opted_out", null, "twilio_21610");
      }
    }

    // 6. store the outbound message (never after a failed send)
    let outboundMessageId: string | null = null;
    if (!sendFailed) {
      const { data: stored, error: storeError } = await supabase
        .from("messages")
        .insert({
          business_id: a.businessId,
          conversation_id: a.conversationId,
          direction: "outbound",
          body: replyText,
          twilio_sid: sid,
        })
        .select("id")
        .single();
      if (storeError) throw storeError;
      outboundMessageId = stored.id;
    }

    // 7. record the run
    const total = await recordRun(supabase, a, {
      outcome,
      outbound_message_id: outboundMessageId,
      model,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      model_latency_ms: modelLatencyMs,
      error_code: errorCode,
      tool_calls: toolCalls,
    });

    // 8. one log line, no bodies, no phone numbers
    logRun(outcome, a.conversationId, total, toolCalls);
  } catch (err) {
    const code = shortError(err);
    console.error("[agent] unexpected error", code);
    try {
      await recordRun(deps?.supabase ?? createAdminClient(), a, {
        outcome: "error",
        error_code: code,
        tool_calls: toolCalls,
      });
    } catch (inner) {
      console.error("[agent] could not record error run", shortError(inner));
    }
  }
}
