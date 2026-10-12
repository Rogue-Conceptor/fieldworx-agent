import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  CUSTOMER_EMAIL_PER_BUSINESS_DAY,
  CUSTOMER_EMAIL_PER_NUMBER_DAY,
  EMAIL_FROM,
  EMAIL_MODE,
} from "./config";

export type EmailStatus = "logged" | "sent" | "failed";

// error_code values on a customer email that was held back by a cap (or by a
// cap check that could not run). The row is "logged", but the email was not
// sent, so it must never count as a confirmation that went out.
export const EMAIL_CAP_CODES = [
  "email_cap_number",
  "email_cap_business",
  "email_cap_check_failed",
] as const;

const RESEND_URL = "https://api.resend.com/emails";
const RESEND_TIMEOUT_MS = 10000;
const ERROR_CODE_MAX = 120;
const DAY_MS = 24 * 60 * 60 * 1000;

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

// Customer emails that were really sent in the last 24 hours, per number and
// per business. Returns "email_cap_number" or "email_cap_business" when a cap
// is reached, null when under both. Fails CLOSED: when the answer cannot be
// found, "email_cap_check_failed", because the harm here is mailing a stranger.
async function customerEmailCapCode(
  supabase: SupabaseClient,
  businessId: string,
  conversationId: string | null,
): Promise<string | null> {
  const failed = "email_cap_check_failed";
  try {
    if (!conversationId) return failed;
    const dayAgo = new Date(Date.now() - DAY_MS).toISOString();

    // The number: every conversation this business has had with it.
    const { data: conversation, error: conversationError } = await supabase
      .from("conversations")
      .select("customer_number")
      .eq("id", conversationId)
      .eq("business_id", businessId)
      .maybeSingle();
    if (conversationError || !conversation?.customer_number) return failed;
    const { data: sameNumber, error: sameNumberError } = await supabase
      .from("conversations")
      .select("id")
      .eq("business_id", businessId)
      .eq("customer_number", conversation.customer_number);
    if (sameNumberError || !sameNumber || sameNumber.length === 0) return failed;

    const { count: numberCount, error: numberError } = await supabase
      .from("notifications")
      .select("id", { count: "exact", head: true })
      .eq("business_id", businessId)
      .eq("audience", "customer")
      .eq("status", "sent")
      .gte("created_at", dayAgo)
      .in(
        "conversation_id",
        sameNumber.map((c) => c.id as string),
      );
    if (numberError || numberCount === null || numberCount === undefined) return failed;
    if (numberCount >= CUSTOMER_EMAIL_PER_NUMBER_DAY) return "email_cap_number";

    const { count: businessCount, error: businessError } = await supabase
      .from("notifications")
      .select("id", { count: "exact", head: true })
      .eq("business_id", businessId)
      .eq("audience", "customer")
      .eq("status", "sent")
      .gte("created_at", dayAgo);
    if (businessError || businessCount === null || businessCount === undefined) return failed;
    if (businessCount >= CUSTOMER_EMAIL_PER_BUSINESS_DAY) return "email_cap_business";
    return null;
  } catch {
    return failed;
  }
}

// Sends (or, in log mode, only records) one email and writes a notifications
// row for it. Never throws, and never logs addresses or bodies. In send mode a
// customer email over a cap, or whose cap cannot be checked, is not sent: it is
// recorded as "logged" with the reason in error_code, and `capped` is true so
// the caller can tell it from an ordinary log-mode "logged". The owner email
// has no cap, and log mode does no counting.
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
): Promise<{ status: EmailStatus; capped: boolean }> {
  let outcome: Outcome;
  let capped = false;
  try {
    const capCode =
      args.audience === "customer" && EMAIL_MODE === "send"
        ? await customerEmailCapCode(supabase, args.businessId, args.conversationId)
        : null;
    if (capCode) {
      capped = true;
      console.warn(`[notify] customer email held back: ${capCode}`);
      outcome = { status: "logged", providerMessageId: null, errorCode: capCode };
    } else {
      outcome = await deliver({ to: args.to, subject: args.subject, text: args.text });
    }
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

  return { status: outcome.status, capped };
}
