import "server-only";
import twilio from "twilio";
import { OUTBOUND_MODE } from "./config";

// In "log" mode nothing leaves the building: Twilio is never contacted.
// Errors from Twilio are deliberately not caught here.
export async function sendOutbound(args: {
  to: string;
  from: string;
  body: string;
}): Promise<{ sid: string | null; sent: boolean }> {
  if (OUTBOUND_MODE !== "send") return { sid: null, sent: false };

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) {
    throw new Error("twilio credentials missing");
  }

  const client = twilio(accountSid, authToken);
  const message = await client.messages.create({
    to: args.to,
    from: args.from,
    body: args.body,
  });
  return { sid: message.sid, sent: true };
}
