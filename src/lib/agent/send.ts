import "server-only";
import twilio from "twilio";
import { OUTBOUND_MODE } from "./config";

const STATUS_CALLBACK_PATH = "/api/webhooks/twilio/status";

// Where Twilio posts delivery-status callbacks for a text, built from
// PUBLIC_BASE_URL. null when it is unset or not a plain https URL (no
// credentials, query or fragment): the text is then sent without a callback.
export function statusCallbackUrl(base: string | undefined): string | null {
  const trimmed = (base ?? "").trim().replace(/\/+$/, "");
  if (!trimmed || /[?#]/.test(trimmed)) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password) {
    return null;
  }
  return trimmed + STATUS_CALLBACK_PATH;
}

// The part of the Twilio client used here; a test passes its own.
type MessageClient = {
  messages: {
    create(params: {
      to: string;
      from: string;
      body: string;
      statusCallback?: string;
    }): Promise<{ sid: string }>;
  };
};

// In "log" mode nothing leaves the building: Twilio is never contacted.
// Errors from Twilio are deliberately not caught here. `deps` lets a test set
// the mode and supply the client; left out, OUTBOUND_MODE and the real client
// (from the TWILIO_* env vars) are used.
export async function sendOutbound(
  args: {
    to: string;
    from: string;
    body: string;
  },
  deps?: { mode?: "log" | "send"; client?: MessageClient },
): Promise<{ sid: string | null; sent: boolean }> {
  if ((deps?.mode ?? OUTBOUND_MODE) !== "send") return { sid: null, sent: false };

  // A missing or bad PUBLIC_BASE_URL never stops a text: it goes out without
  // delivery-status tracking.
  const statusCallback = statusCallbackUrl(process.env.PUBLIC_BASE_URL);
  if (!statusCallback) {
    console.warn(
      "[send] PUBLIC_BASE_URL is unset or not an https URL; sending without a status callback",
    );
  }

  let client = deps?.client;
  if (!client) {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    if (!accountSid || !authToken) {
      throw new Error("twilio credentials missing");
    }
    client = twilio(accountSid, authToken);
  }

  const message = await client.messages.create({
    to: args.to,
    from: args.from,
    body: args.body,
    ...(statusCallback ? { statusCallback } : {}),
  });
  return { sid: message.sid, sent: true };
}
