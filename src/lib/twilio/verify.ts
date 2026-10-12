import "server-only";
import { validateRequest } from "twilio";

// Anything with a URL and headers: a NextRequest, a Request, or a test double.
type TwilioRequest = { url: string; headers: { get(name: string): string | null } };

// Twilio signs the exact public URL it POSTed to. Behind a proxy (Vercel,
// ngrok) request.url can carry an internal host, so rebuild it from the
// forwarded headers when present.
export function getPublicUrl(request: TwilioRequest): string {
  const forwardedHost =
    request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (!forwardedHost) return request.url;
  const proto = request.headers.get("x-forwarded-proto") ?? "https";
  const { pathname, search } = new URL(request.url);
  return `${proto}://${forwardedHost}${pathname}${search}`;
}

export type SignatureCheck = {
  valid: boolean;
  url: string;
  hasSignature: boolean;
  hasAuthToken: boolean;
};

// Is this request really from Twilio? `params` is the parsed form body. The
// other fields are for the caller's failure log (no secrets, no phone numbers).
export function verifyTwilioRequest(
  request: TwilioRequest,
  params: Record<string, string>,
): SignatureCheck {
  const signature = request.headers.get("x-twilio-signature") ?? "";
  const url = getPublicUrl(request);
  const authToken = process.env.TWILIO_AUTH_TOKEN ?? "";
  return {
    valid: validateRequest(authToken, signature, url, params),
    url,
    hasSignature: Boolean(signature),
    hasAuthToken: Boolean(authToken),
  };
}
