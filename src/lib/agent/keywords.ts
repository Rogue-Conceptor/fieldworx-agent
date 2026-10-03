import "server-only";

// Whole-message carrier/compliance keywords. Twilio handles STOP/START/HELP
// itself; the agent must stay silent on all of them.
const OPT_KEYWORDS = new Set([
  "STOP",
  "STOPALL",
  "UNSUBSCRIBE",
  "CANCEL",
  "END",
  "QUIT",
  "START",
  "UNSTOP",
  "HELP",
  "INFO",
]);

const SAFETY_PHRASES = [
  "gas smell",
  "smell gas",
  "smells like gas",
  "smelling gas",
  "gas leak",
  "carbon monoxide",
  "co alarm",
  "co detector",
  "smoke",
  "burning smell",
  "smell burning",
  "smells like burning",
  "something burning",
  "sparks",
  "sparking",
  "on fire",
];

export function classifyInbound(body: string): "opt_keyword" | "safety" | "normal" {
  // Trim, uppercase, drop trailing punctuation; the WHOLE message must match.
  const normalized = body
    .trim()
    .toUpperCase()
    .replace(/[\s.,!?;:'"`)\]}*_~\-–—‘’“”…]+$/, "");
  if (OPT_KEYWORDS.has(normalized)) return "opt_keyword";

  const lower = body.toLowerCase();
  if (SAFETY_PHRASES.some((phrase) => lower.includes(phrase))) return "safety";

  return "normal";
}

export const SAFETY_TEXT =
  "If you smell gas, smoke, or burning, or a carbon monoxide alarm is going off, leave the home now and call 911 or your gas utility from outside. Don't use light switches or appliances on the way out.";

export const FALLBACK_TEXT =
  "Sorry, our text assistant is having trouble right now. Please try again in a few minutes.";
