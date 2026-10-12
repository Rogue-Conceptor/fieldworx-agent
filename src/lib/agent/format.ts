import "server-only";
import { MAX_REPLY_CHARS } from "./config";
import { cutJoinedQuestion } from "./questions";

export const STOP_SUFFIX = "Reply STOP to opt out.";

// Undo formatOutbound so stored outbound messages read as plain assistant
// turns when replayed to the model.
export function stripForHistory(body: string, prefix: string): string {
  let text = body.trim();
  if (text.startsWith(prefix)) text = text.slice(prefix.length).trim();
  if (text.endsWith(STOP_SUFFIX)) text = text.slice(0, -STOP_SUFFIX.length);
  return text.trim();
}

// A period after one of these does not end a sentence ("12 Elm St. Is that
// right?" is one question, not a fragment and a question).
const ABBREVIATIONS = new Set(["st", "ave", "rd", "dr", "ln", "blvd", "mr", "mrs", "ms", "a.m", "p.m"]);

function endsWithAbbreviation(textBeforePeriod: string): boolean {
  const word = /(?:^|\s)([A-Za-z.]+)$/.exec(textBeforePeriod);
  return word !== null && ABBREVIATIONS.has(word[1].toLowerCase());
}

// Sentences end at ".", "?" or "!" (a run like "?!" counts once) that is
// followed by whitespace or the end of the text. A period inside a number
// ("98.6") or a time ("9-11 AM") never has whitespace after it, so it never
// splits.
function splitSentences(text: string): string[] {
  const sentences: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (!".?!".includes(text[i])) continue;
    let end = i;
    while (end + 1 < text.length && ".?!".includes(text[end + 1])) end++;
    const next = text[end + 1];
    const atBoundary = next === undefined || /\s/.test(next);
    const abbreviation = text[end] === "." && endsWithAbbreviation(text.slice(start, end));
    if (atBoundary && !abbreviation) {
      sentences.push(text.slice(start, end + 1).trim());
      start = end + 1;
    }
    i = end;
  }
  const rest = text.slice(start).trim();
  if (rest) sentences.push(rest);
  return sentences;
}

// At most one question per text: every sentence that does not end in "?" stays,
// the first one that does stays, and later question sentences are dropped.
// What is kept keeps its order and is rejoined with single spaces. The kept
// question is also cut where it joins a second question with "and" (see
// cutJoinedQuestion); `cut` says whether that happened.
export function limitQuestions(text: string): { text: string; dropped: number; cut: boolean } {
  let seenQuestion = false;
  let dropped = 0;
  let cut = false;
  const kept: string[] = [];
  for (const sentence of splitSentences(text)) {
    if (sentence.endsWith("?")) {
      if (seenQuestion) {
        dropped++;
        continue;
      }
      seenQuestion = true;
      const shortened = cutJoinedQuestion(sentence);
      if (shortened !== null) {
        kept.push(shortened);
        cut = true;
        continue;
      }
    }
    kept.push(sentence);
  }
  return { text: kept.join(" "), dropped, cut };
}

// The model's reply, ready to send: cleaned, trimmed to one question, capped in
// length, then wrapped in the program prefix and the STOP line.
// `questionsDropped` says how many extra questions the one-question rule cut;
// `compoundCut` says the kept question was shortened at an "and" that joined a
// second question.
export function formatOutboundWithInfo(
  text: string,
  prefix: string,
): { body: string; questionsDropped: number; compoundCut: boolean } {
  const cleaned = text
    .replace(/[*`]/g, "")
    .replace(/\s*Reply\s+STOP\b[^.!?\n]*[.!?]?/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  const limited = limitQuestions(cleaned);
  let out = limited.text;

  if (out.length > MAX_REPLY_CHARS) {
    // Last sentence end that fits; the space after it may sit at the limit.
    const cut = Math.max(
      out.lastIndexOf(". ", MAX_REPLY_CHARS - 1),
      out.lastIndexOf("? ", MAX_REPLY_CHARS - 1),
      out.lastIndexOf("! ", MAX_REPLY_CHARS - 1),
    );
    out = cut >= 0 ? out.slice(0, cut + 1) : out.slice(0, MAX_REPLY_CHARS).trimEnd();
  }

  return {
    body: `${prefix} ${out} ${STOP_SUFFIX}`,
    questionsDropped: limited.dropped,
    compoundCut: limited.cut,
  };
}

export function formatOutbound(text: string, prefix: string): string {
  return formatOutboundWithInfo(text, prefix).body;
}
