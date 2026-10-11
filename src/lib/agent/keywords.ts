import "server-only";

// Whole-message carrier/compliance keywords, the same lists as the Twilio
// console. Twilio answers all of them itself; the agent stays silent, and the
// opt-out and opt-in ones are also recorded per number (see optstatus.ts).
const OPT_OUT_KEYWORDS = new Set([
  "STOP",
  "STOPALL",
  "UNSUBSCRIBE",
  "CANCEL",
  "END",
  "QUIT",
  "OPTOUT",
  "REVOKE",
]);
const OPT_IN_KEYWORDS = new Set(["START", "UNSTOP"]);
const HELP_KEYWORDS = new Set(["HELP", "INFO"]);

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

// A safety phrase is denied ("no smoke") when one of these words comes before
// it in the same clause.
const NEGATORS = new Set([
  "no",
  "not",
  "don't",
  "dont",
  "doesn't",
  "doesnt",
  "didn't",
  "didnt",
  "isn't",
  "isnt",
  "aren't",
  "arent",
  "wasn't",
  "wasnt",
  "never",
  "nothing",
  "without",
  "none",
]);

// Start of the longest safety phrase that `text` ends with, or -1.
function phraseStartEndingText(text: string): number {
  let start = -1;
  let longest = 0;
  for (const phrase of SAFETY_PHRASES) {
    if (phrase.length > longest && text.endsWith(phrase)) {
      start = text.length - phrase.length;
      longest = phrase.length;
    }
  }
  return start;
}

// Is the safety phrase that starts at `at` in this clause denied? Only if
//  (a) a negator is one of the two words right before it ("no smoke",
//      "don't smell gas"), or
//  (b) it continues a denied phrase with "or" / "nor" ("no burning smell or
//      smoke": "smoke" is denied because "burning smell" is).
// A negator any further back does not count, so "no heat and I smell gas"
// still alarms.
function isNegatedAt(clause: string, at: number): boolean {
  const before = clause.slice(0, at);
  const words = before.match(/[a-z']+/g) ?? [];
  if (words.slice(-2).some((word) => NEGATORS.has(word))) return true;

  const joiner = /\s(?:or|nor)\s+$/.exec(before);
  if (joiner) {
    const previous = phraseStartEndingText(before.slice(0, joiner.index).trimEnd());
    if (previous !== -1) return isNegatedAt(clause, previous);
  }
  return false;
}

// A clause is a live alarm if any safety phrase in it is not denied.
function hasLiveSafetyPhrase(clause: string): boolean {
  return SAFETY_PHRASES.some((phrase) => {
    for (let at = clause.indexOf(phrase); at !== -1; at = clause.indexOf(phrase, at + 1)) {
      if (!isNegatedAt(clause, at)) return true;
    }
    return false;
  });
}

// Clauses break at punctuation and at " but ", " though ", " however " and
// " and ", so a denial never reaches across to a different statement.
const CLAUSE_BREAK = /[,.;:!?]|\s(?:but|though|however|and)\s/;

// A keyword kind carries the matched keyword (uppercase, punctuation dropped).
export type Classification =
  | { kind: "opt_out" | "opt_in" | "help"; keyword: string }
  | { kind: "safety" | "normal"; keyword: null };

export function classifyInbound(body: string): Classification {
  // Trim, uppercase, drop trailing punctuation; the WHOLE message must match.
  const normalized = body
    .trim()
    .toUpperCase()
    .replace(/[\s.,!?;:'"`)\]}*_~\-–—‘’“”…]+$/, "");
  if (OPT_OUT_KEYWORDS.has(normalized)) return { kind: "opt_out", keyword: normalized };
  if (OPT_IN_KEYWORDS.has(normalized)) return { kind: "opt_in", keyword: normalized };
  if (HELP_KEYWORDS.has(normalized)) return { kind: "help", keyword: normalized };

  // Safety is judged clause by clause so "no smoke, but I smell gas" still
  // alarms while "no gas smell, no smoke" does not. A message whose safety
  // words are all denied is "normal": the model's own Safety rule covers it.
  const lower = body.toLowerCase().replace(/[‘’]/g, "'");
  if (lower.split(CLAUSE_BREAK).some(hasLiveSafetyPhrase)) return { kind: "safety", keyword: null };

  return { kind: "normal", keyword: null };
}

export const SAFETY_TEXT =
  "If you smell gas, smoke, or burning, or a carbon monoxide alarm is going off, leave the home now and call 911 or your gas utility from outside. Don't use light switches or appliances on the way out.";

export const FALLBACK_TEXT =
  "Sorry, our text assistant is having trouble right now. Please try again in a few minutes.";

export const OPT_IN_TEXT = "Fieldworx Demo: Thanks for texting the Fieldworx Demo AI assistant. Msg frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to opt out.";
