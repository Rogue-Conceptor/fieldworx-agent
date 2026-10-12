import "server-only";

// The one definition of "two questions joined by 'and'", used by the formatter
// backstop (format.ts) and by the eval's check on every reply.

// A word that starts a question. "and is ..." / "and when ..." means a second
// question was joined to the first. "any" and "anyone" are left out: they turn
// up inside lists ("... or anyone with a condition").
const QUESTION_STARTERS = [
  "is", "are", "do", "does", "did", "can", "could", "will", "would", "has", "have",
  "was", "were", "should", "what", "when", "where", "which", "who", "how",
];
const JOINED_QUESTION = new RegExp(`\\band\\s+(?:${QUESTION_STARTERS.join("|")})\\b`, "i");

// Cuts one question sentence at the first "and" that is directly followed by a
// question-starting word (and drops the comma before it). The kept part ends
// with "?". Returns null when there is nothing to cut.
//   "Is it running at all, and is anyone vulnerable at home?" -> "Is it running at all?"
// Not cut: "Is it blowing air and making noise?", "Is it running at all, or is
// it completely off?" (a single either/or question), lists with "or anyone".
export function cutJoinedQuestion(question: string): string | null {
  const join = JOINED_QUESTION.exec(question);
  if (!join) return null;
  const kept = question.slice(0, join.index).replace(/[\s,]+$/, "");
  return kept ? `${kept}?` : null;
}

// Sentences end at ".", "?" or "!" followed by whitespace, so "98.6" and
// "9-11 AM" never split.
function sentences(text: string): string[] {
  return text
    .split(/(?<=[.?!])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// The sentences of `reply` that end in "?" and would be cut by
// cutJoinedQuestion, in order. A guard, not proof: a false positive is
// accepted.
export function findCompoundQuestions(reply: string): string[] {
  return sentences(reply).filter((s) => s.endsWith("?") && cutJoinedQuestion(s) !== null);
}
