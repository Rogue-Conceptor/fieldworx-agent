import "server-only";
import type { SignatureCheck } from "./verify";

export type StatusCallbackDeps = {
  // Is the request really from Twilio? Gets the parsed form body.
  verify: (params: Record<string, string>) => SignatureCheck;
  // The database function call (service_role). Supabase reports failure in the
  // result's `error`; a thrown error is handled too.
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ error: unknown }>;
};

// Applies one Twilio delivery-status callback. Returns the HTTP status for
// the route to send: 403 for a bad signature, otherwise always 200, so Twilio
// never retries because of a database problem or an unknown message. Log lines
// are fixed strings: no phone numbers, names or message text.
export async function handleStatusCallback(
  params: Record<string, string>,
  deps: StatusCallbackDeps,
): Promise<200 | 403> {
  const check = deps.verify(params);
  if (!check.valid) {
    console.warn("[twilio-status] signature validation FAILED", {
      url: check.url,
      hasSignature: check.hasSignature,
      hasAuthToken: check.hasAuthToken,
    });
    return 403;
  }

  const sid = params.MessageSid ?? "";
  const status = params.MessageStatus ?? "";
  if (!sid || !status) {
    console.warn("[twilio-status] callback without MessageSid or MessageStatus");
    return 200;
  }

  try {
    const { error } = await deps.rpc("record_message_status", {
      p_sid: sid,
      p_status: status,
      p_error_code: params.ErrorCode || null,
    });
    if (error) console.error("[twilio-status] status update failed");
  } catch {
    console.error("[twilio-status] status update failed");
  }
  return 200;
}
