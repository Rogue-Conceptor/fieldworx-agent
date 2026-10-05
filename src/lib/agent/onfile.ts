import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeZip } from "./area";
import { slotLabel, type SlotKind } from "./clock";
import { kindLabel } from "./emails";

export type OnFile = {
  customer: { id: string; name: string; email: string | null } | null;
  location: { id: string; address: string } | null;
  zip: string | null;
  appointments: {
    id: string;
    kind: SlotKind;
    start: string;
    label: string;
    status: string;
  }[];
};

// What the shop already knows about this lead: its customer, that customer's
// most recent service location, and the lead's scheduled appointments. Always
// scoped to the business. Throws on a database error.
export async function loadOnFile(
  supabase: SupabaseClient,
  args: { businessId: string; leadId: string },
): Promise<OnFile> {
  const { businessId, leadId } = args;

  const { data: lead, error: leadError } = await supabase
    .from("leads")
    .select("customer_id")
    .eq("id", leadId)
    .eq("business_id", businessId)
    .maybeSingle();
  if (leadError) throw leadError;

  let customer: OnFile["customer"] = null;
  let location: OnFile["location"] = null;
  if (lead?.customer_id) {
    const { data: customerRow, error: customerError } = await supabase
      .from("customers")
      .select("id, name, email")
      .eq("id", lead.customer_id)
      .eq("business_id", businessId)
      .maybeSingle();
    if (customerError) throw customerError;
    if (customerRow) {
      customer = {
        id: customerRow.id,
        name: customerRow.name,
        email: customerRow.email ?? null,
      };

      const { data: locationRow, error: locationError } = await supabase
        .from("service_locations")
        .select("id, address")
        .eq("customer_id", customerRow.id)
        .eq("business_id", businessId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (locationError) throw locationError;
      if (locationRow) location = { id: locationRow.id, address: locationRow.address };
    }
  }

  const { data: appointmentRows, error: appointmentError } = await supabase
    .from("appointments")
    .select("id, kind, starts_at, status")
    .eq("lead_id", leadId)
    .eq("business_id", businessId)
    .eq("status", "scheduled")
    .order("starts_at", { ascending: true });
  if (appointmentError) throw appointmentError;

  return {
    customer,
    location,
    zip: location ? normalizeZip(location.address) : null,
    appointments: (appointmentRows ?? []).map((row) => ({
      id: row.id as string,
      kind: row.kind as SlotKind,
      start: new Date(row.starts_at as string).toISOString(),
      label: slotLabel(row.kind as SlotKind, row.starts_at as string),
      status: row.status as string,
    })),
  };
}

// Stored values came from the customer, so they are flattened to one line
// before they go into the system prompt.
function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

// Bullet lines for the system prompt's "On file for this customer" section.
export function formatOnFile(onFile: OnFile): string {
  if (!onFile.customer && !onFile.location && onFile.appointments.length === 0) {
    return "- Nothing on file yet.";
  }
  const lines = [
    `- Name: ${onFile.customer ? oneLine(onFile.customer.name) : "(none)"}`,
    `- Address: ${onFile.location ? oneLine(onFile.location.address) : "(none)"}`,
    `- Email: ${onFile.customer?.email ? oneLine(onFile.customer.email) : "(none)"}`,
  ];
  for (const appointment of onFile.appointments) {
    lines.push(
      `- Appointment: ${kindLabel(appointment.kind)}, ${appointment.label} (${appointment.status})`,
    );
  }
  return lines.join("\n");
}
