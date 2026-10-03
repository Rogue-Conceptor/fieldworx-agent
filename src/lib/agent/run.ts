import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  AGENT_EFFORT,
  AGENT_MODEL,
  CLAUDE_TIMEOUT_MS,
  MAX_TOKENS,
  OUTBOUND_MODE,
} from "./config";
import { formatOutbound } from "./format";
import { loadHistory } from "./history";
import {
  classifyInbound,
  FALLBACK_TEXT,
  OPT_IN_TEXT,
  SAFETY_TEXT,
} from "./keywords";
import { buildSystemPrompt, type AgentProfile } from "./prompt";
import { sendOutbound } from "./send";

type Outcome =
  | "replied"
  | "fallback"
  | "skipped_keyword"
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

type RunFields = {
  outcome: Outcome;
  outbound_message_id?: string | null;
  model?: string | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  model_latency_ms?: number | null;
  error_code?: string | null;
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
    ...row,
  });
  if (error) throw error;
  return totalLatencyMs;
}

function logRun(outcome: Outcome, conversationId: string, totalLatencyMs: number) {
  console.log("[agent] run complete", {
    outcome,
    conversation_id: conversationId,
    mode: OUTBOUND_MODE,
    total_latency_ms: totalLatencyMs,
  });
}

// Never throws: any unexpected failure is logged (masked) and recorded as an
// "error" run when possible.
export async function processInbound(a: ProcessInboundArgs): Promise<void> {
  try {
    const supabase = createAdminClient();

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

    // 2. carrier keywords get no reply; safety skips the model
    const kind = classifyInbound(a.inboundBody);
    if (kind === "opt_keyword") {
      const total = await recordRun(supabase, a, { outcome: "skipped_keyword" });
      logRun("skipped_keyword", a.conversationId, total);
      return;
    }

    // 2b. first text of a new conversation: opt-in confirmation, sent exactly
    // as written (not through formatOutbound) and with no agent_runs row of
    // its own. A failure here must never block the agent's reply.
    if (a.conversationIsNew) {
      try {
        const sent = await sendOutbound({
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
        console.error("[agent] opt-in confirmation failed", shortError(err));
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

      if (history.length === 0) {
        failure = "empty_history";
      } else {
        model = AGENT_MODEL;
        const started = Date.now();
        try {
          const response = await new Anthropic({
            timeout: CLAUDE_TIMEOUT_MS,
            maxRetries: 1,
          }).messages.create({
            model: AGENT_MODEL,
            max_tokens: MAX_TOKENS,
            thinking: { type: "adaptive" },
            output_config: { effort: AGENT_EFFORT },
            system: buildSystemPrompt(profile),
            messages: history,
          });
          modelLatencyMs = Date.now() - started;
          inputTokens = response.usage.input_tokens;
          outputTokens = response.usage.output_tokens;
          modelText = response.content
            .flatMap((block) => (block.type === "text" ? [block.text] : []))
            .join("")
            .trim();
          // Partial text is never sent: a cut-off reply is a failure.
          if (response.stop_reason === "max_tokens") failure = "max_tokens";
          else if (!modelText) failure = "empty_response";
        } catch (err) {
          modelLatencyMs = Date.now() - started;
          failure = shortError(err);
        }
      }

      if (failure !== null) {
        outcome = "fallback";
        errorCode = failure;
        replyText = formatOutbound(FALLBACK_TEXT, prefix);
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
      } else {
        outcome = "replied";
        replyText = formatOutbound(modelText, prefix);
      }

      // 4. a newer inbound message means this reply is stale
      const { data: newest, error: newestError } = await supabase
        .from("messages")
        .select("id")
        .eq("conversation_id", a.conversationId)
        .eq("direction", "inbound")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (newestError) throw newestError;
      if (newest && newest.id !== a.inboundMessageId) {
        const total = await recordRun(supabase, a, {
          outcome: "superseded",
          model,
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          model_latency_ms: modelLatencyMs,
        });
        logRun("superseded", a.conversationId, total);
        return;
      }
    }

    // 5. send (or log) the reply
    let sid: string | null = null;
    let sendFailed = false;
    try {
      const sent = await sendOutbound({
        to: a.customerNumber,
        from: a.businessNumber,
        body: replyText,
      });
      sid = sent.sid;
    } catch (err) {
      sendFailed = true;
      outcome = "send_failed";
      errorCode = sendErrorCode(err);
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
    });

    // 8. one log line, no bodies, no phone numbers
    logRun(outcome, a.conversationId, total);
  } catch (err) {
    const code = shortError(err);
    console.error("[agent] unexpected error", code);
    try {
      await recordRun(createAdminClient(), a, {
        outcome: "error",
        error_code: code,
      });
    } catch (inner) {
      console.error("[agent] could not record error run", shortError(inner));
    }
  }
}
