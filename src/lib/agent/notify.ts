import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { EMAIL_FROM, EMAIL_MODE } from "./config";

export type EmailStatus = "logged" | "sent" | "failed";

const RESEND_URL = "https://api.resend.com/emails";
const RESEND_TIMEOUT_MS = 10000;
const ERROR_CODE_MAX = 120;

type Outcome = {
  status: EmailStatus;
  providerMessageId: string | null;
  errorCode: string | null;
};

// Error text from Resend or the network can echo the recipient back, so
// anything shaped like an address is masked before it is stored.
function maskedError(prefix: string, detail: string): string {
  const cleaned = detail
    .replace(/[^\s@<>,;"']+@[^\s@<>,;"']+/g, "[email]")
    .replace(/\s+/g, " ")
    .trim();
  return `${prefix} ${cleaned}`.trim().slice(0, ERROR_CODE_MAX);
}

async function deliver(args: {
  to: string;
  subject: string;
  text: string;
}): Promise<Outcome> {
  if (EMAIL_MODE !== "send") {
    return { status: "logged", providerMessageId: null, errorCode: null };
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return { status: "failed", providerMessageId: null, errorCode: "missing_api_key" };
  }

  try {
    const res = await fetch(RESEND_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: EMAIL_FROM,
        to: [args.to],
        subject: args.subject,
        text: args.text,
      }),
      signal: AbortSignal.timeout(RESEND_TIMEOUT_MS),
    });

    const payload = (await res.json().catch(() => null)) as {
      id?: unknown;
      message?: unknown;
    } | null;

    if (!res.ok) {
      const detail = typeof payload?.message === "string" ? payload.message : "";
      return {
        status: "failed",
        providerMessageId: null,
        errorCode: maskedError(String(res.status), detail),
      };
    }
    return {
      status: "sent",
      providerMessageId: typeof payload?.id === "string" ? payload.id : null,
      errorCode: null,
    };
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    return {
      status: "failed",
      providerMessageId: null,
      errorCode: timedOut
        ? "timeout"
        : maskedError("network", err instanceof Error ? err.message : ""),
    };
  }
}

// Sends (or, in log mode, only records) one email and writes a notifications
// row for it. Never throws, and never logs addresses or bodies.
export async function sendEmail(
  supabase: SupabaseClient,
  args: {
    businessId: string;
    conversationId: string | null;
    leadId: string | null;
    appointmentId?: string | null;
    audience: "owner" | "customer";
    to: string;
    template: string;
    subject: string;
    text: string;
  },
): Promise<{ status: EmailStatus }> {
  let outcome: Outcome;
  try {
    outcome = await deliver({ to: args.to, subject: args.subject, text: args.text });
  } catch {
    outcome = { status: "failed", providerMessageId: null, errorCode: "unexpected" };
  }

  try {
    const { error } = await supabase.from("notifications").insert({
      business_id: args.businessId,
      appointment_id: args.appointmentId ?? null,
      lead_id: args.leadId,
      conversation_id: args.conversationId,
      audience: args.audience,
      recipient: args.to,
      template: args.template,
      subject: args.subject,
      status: outcome.status,
      provider_message_id: outcome.providerMessageId,
      error_code: outcome.errorCode,
    });
    if (error) console.error("[notify] record failed");
  } catch {
    console.error("[notify] record failed");
  }

  return { status: outcome.status };
}
