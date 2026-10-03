import { NextRequest } from "next/server";
import { waitUntil } from "@vercel/functions";
import { validateRequest } from "twilio";
import { processInbound } from "@/lib/agent/run";
import { createAdminClient } from "@/lib/supabase/admin";

// twilio's signature validation uses Node's crypto, so this must run on the
// Node.js runtime (not Edge).
export const runtime = "nodejs";

const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

function twimlResponse() {
  return new Response(EMPTY_TWIML, {
    status: 200,
    headers: { "Content-Type": "text/xml" },
  });
}

// Twilio signs the exact public URL it POSTed to. Behind a proxy (Vercel,
// ngrok) request.url can carry an internal host, so rebuild it from the
// forwarded headers when present.
function getPublicUrl(request: NextRequest): string {
  const forwardedHost =
    request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (!forwardedHost) return request.url;
  const proto = request.headers.get("x-forwarded-proto") ?? "https";
  const { pathname, search } = new URL(request.url);
  return `${proto}://${forwardedHost}${pathname}${search}`;
}

// Phone numbers must never appear in full in any log line.
function maskPhone(n: string): string {
  return n.length < 4 ? "***" : "***" + n.slice(-4);
}

// Shape returned by the ingest_inbound_sms database function.
interface IngestResult {
  status: "stored" | "duplicate" | "unrouted" | "invalid";
  business_id?: string;
  lead_id?: string;
  conversation_id?: string;
  message_id?: string;
  conversation_is_new?: boolean;
}

export async function POST(request: NextRequest) {
  const receivedAt = Date.now();
  // 1 + 2: read the raw form-encoded body and parse it.
  const rawBody = await request.text();
  const parsed = new URLSearchParams(rawBody);

  const params: Record<string, string> = {};
  parsed.forEach((value, key) => {
    params[key] = value;
  });

  const from = parsed.get("From") ?? "";
  const to = parsed.get("To") ?? "";
  const body = parsed.get("Body") ?? "";
  const messageSid = parsed.get("MessageSid") ?? "";

  console.log("[twilio-webhook] inbound SMS", {
    from: maskPhone(from),
    to: maskPhone(to),
    messageSid,
    bodyLength: body.length,
  });

  // 3: validate the request really came from Twilio.
  const signature = request.headers.get("x-twilio-signature") ?? "";
  const url = getPublicUrl(request);
  const authToken = process.env.TWILIO_AUTH_TOKEN ?? "";

  const isValid = validateRequest(authToken, signature, url, params);
  if (!isValid) {
    console.warn("[twilio-webhook] signature validation FAILED", {
      url,
      hasSignature: Boolean(signature),
      hasAuthToken: Boolean(authToken),
    });
    return new Response("Forbidden", { status: 403 });
  }

  // 4 + 8: admin client (no user session), all DB work wrapped so a failure
  // still returns 200 and Twilio does not retry-storm.
  try {
    const supabase = createAdminClient();

    // All intake work (dedupe, routing, conversation reuse, message insert)
    // happens in one database function, in a single transaction.
    const { data, error } = await supabase.rpc("ingest_inbound_sms", {
      p_to: to,
      p_from: from,
      p_body: body,
      p_sid: messageSid || null,
    });

    if (error) {
      console.error("[twilio-webhook] ingest rpc error", error);
      return twimlResponse();
    }

    const result = data as IngestResult;

    switch (result.status) {
      case "stored":
        console.log("[twilio-webhook] stored inbound message", {
          conversation_id: result.conversation_id,
          message_id: result.message_id,
          conversation_is_new: result.conversation_is_new,
        });
        waitUntil(
          processInbound({
            businessId: result.business_id!,
            conversationId: result.conversation_id!,
            inboundMessageId: result.message_id!,
            leadId: result.lead_id!,
            customerNumber: from,
            businessNumber: to,
            inboundBody: body,
            conversationIsNew: result.conversation_is_new === true,
            receivedAt,
          }),
        );
        break;
      case "duplicate":
        console.log(
          "[twilio-webhook] duplicate delivery ignored",
          result.conversation_id,
        );
        break;
      case "unrouted":
        console.warn(
          "[twilio-webhook] no active inbound number for",
          maskPhone(to),
          "— ignoring",
        );
        break;
      case "invalid":
        console.warn("[twilio-webhook] invalid inbound payload — ignoring");
        break;
    }

    return twimlResponse();
  } catch (error) {
    console.error(
      "[twilio-webhook] DB error — returning 200 empty TwiML to avoid retry storm",
      error,
    );
    return twimlResponse();
  }
}
