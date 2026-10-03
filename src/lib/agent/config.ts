import "server-only";

export const AGENT_MODEL = process.env.AGENT_MODEL ?? "claude-sonnet-5-5";

// Anything other than exactly "send" means "log": replies are stored but never
// sent through Twilio.
export const OUTBOUND_MODE: "log" | "send" =
  process.env.OUTBOUND_MODE === "send" ? "send" : "log";

export const HISTORY_LIMIT = 20;
export const MAX_TOKENS = 2048;

// Only exactly "medium" or "high" are accepted; anything else means "low".
export const AGENT_EFFORT: "low" | "medium" | "high" =
  process.env.AGENT_EFFORT === "medium" || process.env.AGENT_EFFORT === "high"
    ? process.env.AGENT_EFFORT
    : "low";
export const CLAUDE_TIMEOUT_MS = 20000;
export const MAX_REPLY_CHARS = 280;
