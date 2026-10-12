import { NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { handleStatusCallback } from "@/lib/twilio/status";
import { verifyTwilioRequest } from "@/lib/twilio/verify";

// twilio's signature validation uses Node's crypto, so this must run on the
// Node.js runtime (not Edge).
export const runtime = "nodejs";

// Twilio's delivery-status callback for texts we sent. The logic lives in
// src/lib/twilio/status.ts; this file only wires in the real signature check
// and the service_role client.
export async function POST(request: NextRequest) {
  const parsed = new URLSearchParams(await request.text());
  const params: Record<string, string> = {};
  parsed.forEach((value, key) => {
    params[key] = value;
  });

  const status = await handleStatusCallback(params, {
    verify: (p) => verifyTwilioRequest(request, p),
    rpc: (fn, args) => createAdminClient().rpc(fn, args),
  });

  if (status === 403) return new Response("Forbidden", { status: 403 });
  return new Response(null, { status: 200 });
}
