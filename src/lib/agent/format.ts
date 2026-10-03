import "server-only";
import { MAX_REPLY_CHARS } from "./config";

export const STOP_SUFFIX = "Reply STOP to opt out.";

// Undo formatOutbound so stored outbound messages read as plain assistant
// turns when replayed to the model.
export function stripForHistory(body: string, prefix: string): string {
  let text = body.trim();
  if (text.startsWith(prefix)) text = text.slice(prefix.length).trim();
  if (text.endsWith(STOP_SUFFIX)) text = text.slice(0, -STOP_SUFFIX.length);
  return text.trim();
}

export function formatOutbound(text: string, prefix: string): string {
  let out = text
    .replace(/[*`]/g, "")
    .replace(/\s*Reply\s+STOP\b[^.!?\n]*[.!?]?/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  if (out.length > MAX_REPLY_CHARS) {
    // Last sentence end that fits; the space after it may sit at the limit.
    const cut = Math.max(
      out.lastIndexOf(". ", MAX_REPLY_CHARS - 1),
      out.lastIndexOf("? ", MAX_REPLY_CHARS - 1),
      out.lastIndexOf("! ", MAX_REPLY_CHARS - 1),
    );
    out = cut >= 0 ? out.slice(0, cut + 1) : out.slice(0, MAX_REPLY_CHARS).trimEnd();
  }

  return `${prefix} ${out} ${STOP_SUFFIX}`;
}
