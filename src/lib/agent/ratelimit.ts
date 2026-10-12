import "server-only";
import type { createAdminClient } from "@/lib/supabase/admin";
import { RATE_PER_BUSINESS_DAY, RATE_PER_NUMBER_DAY, RATE_PER_NUMBER_HOUR } from "./config";

type Admin = ReturnType<typeof createAdminClient>;

export type RateLimitReason = "per_number_hour" | "per_number_day" | "per_business_day";

// The runs where the agent actually ran. skipped_keyword, skipped_opted_out and
// rate_limited are free: they cost nothing, and counting rate_limited would
// keep a number locked out for as long as it keeps texting.
export const COUNTED_OUTCOMES = [
  "replied",
  "fallback",
  "safety",
  "superseded",
  "send_failed",
  "error",
];

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// Is this number (or this business) over a limit? At or over a limit is limited.
// Checked in order: number per hour, number per day, business per day.
//
// A query error never blocks: that limit is skipped and `checkFailed` is set,
// so the caller can log it. (A broken check must not stop delivery; only the
// opt-out check fails closed.)
export async function checkRateLimit(
  supabase: Admin,
  businessId: string,
  customerNumber: string,
  now: Date = new Date(),
): Promise<{ limited: RateLimitReason | null; checkFailed: boolean }> {
  const dayAgo = new Date(now.getTime() - DAY_MS).toISOString();
  const hourAgo = now.getTime() - HOUR_MS;
  let checkFailed = false;

  // Per number: the runs of every conversation this number has had with this
  // business. Bounded: runs over the limit are rate_limited and do not count.
  try {
    const { data: conversations, error: conversationError } = await supabase
      .from("conversations")
      .select("id")
      .eq("business_id", businessId)
      .eq("customer_number", customerNumber);
    if (conversationError) throw conversationError;
    const ids = (conversations ?? []).map((c) => c.id as string);
    if (ids.length > 0) {
      const { data: runs, error: runError } = await supabase
        .from("agent_runs")
        .select("created_at")
        .eq("business_id", businessId)
        .in("conversation_id", ids)
        .in("outcome", COUNTED_OUTCOMES)
        .gte("created_at", dayAgo);
      if (runError) throw runError;
      const times = (runs ?? []).map((r) => Date.parse(r.created_at as string));
      if (times.filter((t) => t >= hourAgo).length >= RATE_PER_NUMBER_HOUR) {
        return { limited: "per_number_hour", checkFailed };
      }
      if (times.length >= RATE_PER_NUMBER_DAY) {
        return { limited: "per_number_day", checkFailed };
      }
    }
  } catch {
    checkFailed = true;
  }

  // Per business: every number together.
  try {
    const { count, error } = await supabase
      .from("agent_runs")
      .select("id", { count: "exact", head: true })
      .eq("business_id", businessId)
      .in("outcome", COUNTED_OUTCOMES)
      .gte("created_at", dayAgo);
    if (error) throw error;
    if ((count ?? 0) >= RATE_PER_BUSINESS_DAY) {
      return { limited: "per_business_day", checkFailed };
    }
  } catch {
    checkFailed = true;
  }

  return { limited: null, checkFailed };
}
