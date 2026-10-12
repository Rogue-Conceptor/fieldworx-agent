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

// Anything other than exactly "send" means "log": emails are recorded in
// notifications but never sent through Resend.
export const EMAIL_MODE: "log" | "send" =
  process.env.EMAIL_MODE === "send" ? "send" : "log";
export const EMAIL_FROM = "Fieldworx Demo <bookings@notify.jerrster.com>";

export const MAX_TOOL_ROUNDS = 5;

// Abuse guards. A text over any rate limit gets no reply at all (outcome
// rate_limited). Only runs where the agent actually ran count (see
// ratelimit.ts). The email caps count customer emails that were really sent.
export const RATE_PER_NUMBER_HOUR = 10;
export const RATE_PER_NUMBER_DAY = 25;
export const RATE_PER_BUSINESS_DAY = 100;
export const CUSTOMER_EMAIL_PER_NUMBER_DAY = 3;
export const CUSTOMER_EMAIL_PER_BUSINESS_DAY = 20;

// Wall-clock budget for one run, measured from when the webhook received the
// message. Past it, no new model call or tool execution starts.
export const RUN_DEADLINE_MS = 45000;

// Bookable time windows, Central time. Visits are ranges; calls are a start
// time plus a duration.
export const VISIT_WINDOWS = [
  { startHour: 9, endHour: 11, label: "9-11 AM" },
  { startHour: 13, endHour: 15, label: "1-3 PM" },
];
export const CALL_TIMES = [
  { hour: 10, minute: 0, durationMin: 30, label: "10:00 AM" },
  { hour: 15, minute: 0, durationMin: 30, label: "3:00 PM" },
];
