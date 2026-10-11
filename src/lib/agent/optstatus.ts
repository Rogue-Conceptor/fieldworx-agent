import "server-only";
import type { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

export type OptStatus = "opted_out" | "opted_in";
export type OptSource = "keyword" | "twilio_21610";

// Upserts the number's row for this business. A Twilio refusal has no keyword
// (pass null): the column is then left out, so the last keyword the customer
// really sent stays. Throws on a DB error.
export async function recordOptStatus(
  supabase: Admin,
  businessId: string,
  phone: string,
  status: OptStatus,
  keyword: string | null,
  source: OptSource,
): Promise<void> {
  const row: Record<string, string> = {
    business_id: businessId,
    phone,
    status,
    source,
  };
  if (keyword !== null) row.last_keyword = keyword;
  const { error } = await supabase
    .from("sms_opt_status")
    .upsert(row, { onConflict: "business_id,phone" });
  if (error) throw error;
}

// No row means not opted out. Throws on a DB error: the caller decides what an
// unknown answer means.
export async function isOptedOut(
  supabase: Admin,
  businessId: string,
  phone: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from("sms_opt_status")
    .select("status")
    .eq("business_id", businessId)
    .eq("phone", phone)
    .maybeSingle();
  if (error) throw error;
  return data?.status === "opted_out";
}
