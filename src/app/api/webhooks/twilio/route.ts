import { NextRequest } from "next/server";
import { validateRequest } from "twilio";
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

export async function POST(request: NextRequest) {
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
    from,
    to,
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

    // 5: find the business that owns the destination number.
    const { data: inboundNumber, error: lookupError } = await supabase
      .from("inbound_numbers")
      .select("business_id")
      .eq("phone_number", to)
      .eq("is_active", true)
      .maybeSingle();

    if (lookupError) {
      console.error("[twilio-webhook] inbound_numbers lookup error", lookupError);
      return twimlResponse();
    }

    if (!inboundNumber) {
      console.warn(
        "[twilio-webhook] no active inbound number registered for",
        to,
        "— ignoring",
      );
      return twimlResponse();
    }

    const businessId = inboundNumber.business_id;
    console.log("[twilio-webhook] matched business", businessId);

    // 6a: lead
    const { data: lead, error: leadError } = await supabase
      .from("leads")
      .insert({
        business_id: businessId,
        status: "new",
        source: "agent_inbound",
      })
      .select("id")
      .single();
    if (leadError) throw leadError;
    console.log("[twilio-webhook] created lead", lead.id);

    // 6b: conversation
    const { data: conversation, error: convError } = await supabase
      .from("conversations")
      .insert({
        business_id: businessId,
        lead_id: lead.id,
        channel: "sms",
        customer_number: from,
        business_number: to,
        status: "active",
      })
      .select("id")
      .single();
    if (convError) throw convError;
    console.log("[twilio-webhook] created conversation", conversation.id);

    // 6c: message
    const { error: msgError } = await supabase.from("messages").insert({
      business_id: businessId,
      conversation_id: conversation.id,
      direction: "inbound",
      body,
      twilio_sid: messageSid,
    });
    if (msgError) throw msgError;
    console.log("[twilio-webhook] stored inbound message", messageSid);

    // 7: acknowledge with empty TwiML.
    return twimlResponse();
  } catch (error) {
    console.error(
      "[twilio-webhook] DB error — returning 200 empty TwiML to avoid retry storm",
      error,
    );
    return twimlResponse();
  }
}
