import "server-only";
import type Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isValidEmail, normalizeZip, zipInArea } from "./area";
import { buildSlots, openSlots, type Slot, type SlotKind } from "./clock";
import {
  bookingCustomerEmail,
  bookingOwnerEmail,
  escalationOwnerEmail,
  kindLabel,
} from "./emails";
import { sendEmail, type EmailStatus } from "./notify";
import { loadOnFile } from "./onfile";
import type { AgentProfile } from "./prompt";

// Everything a tool needs to know about WHO and WHERE comes from here, never
// from the model: business, phone number, conversation and lead are fixed by
// the inbound message that started the run.
export type ToolContext = {
  supabase: SupabaseClient;
  businessId: string;
  conversationId: string;
  leadId: string;
  customerNumber: string;
  profile: AgentProfile;
  now: Date;
};

export type ToolResult = {
  ok: boolean;
  wrote: boolean; // true once anything was persisted
  result: Record<string, unknown>;
};

const KINDS: readonly SlotKind[] = ["service_visit", "estimate_visit", "phone_call"];
const URGENCIES = ["emergency", "high", "normal"] as const;

const NAME_MAX = 100;
const ADDRESS_MAX = 200;
const TEXT_MAX = 300;

const ZIP_MESSAGE = "That doesn't look like a 5-digit ZIP code.";
const SAVE_FAILED = "Couldn't save the details right now. Please try again.";
const BOOKING_FAILED = "Booking failed; please try again.";
const SLOT_UNAVAILABLE =
  "That time isn't available. Call get_available_slots for current openings.";

export const TOOL_DEFINITIONS: Anthropic.Tool[] = [
  {
    name: "get_available_slots",
    description:
      "List the open appointment times for the next few business days. Call this before offering times to the customer. Use kind service_visit for a repair visit, estimate_visit for pricing a replacement or new install, phone_call for a call with the owner.",
    input_schema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: [...KINDS] },
      },
      required: ["kind"],
    },
  },
  {
    name: "check_service_area",
    description:
      "Check whether a ZIP code is inside the service area. Call this before booking a visit.",
    input_schema: {
      type: "object",
      properties: {
        zip: { type: "string", description: "The customer's 5-digit ZIP code." },
      },
      required: ["zip"],
    },
  },
  {
    name: "save_customer_details",
    description:
      "Save what the customer has told you: their name, and for visits their street address and ZIP, and an email only if they chose to give one. Safe to call again to add details.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The customer's name." },
        street_address: {
          type: "string",
          description: "Street address only, without the ZIP.",
        },
        zip: { type: "string", description: "5-digit ZIP code for the address." },
        email: { type: "string", description: "Email for a confirmation, if they want one." },
      },
      required: ["name"],
    },
  },
  {
    name: "book_appointment",
    description:
      "Book the appointment the customer chose. slot_start must be exactly a start value returned by get_available_slots for the same kind. The customer's name must be saved first, and a visit also needs a saved street address and ZIP inside the service area.",
    input_schema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: [...KINDS] },
        slot_start: {
          type: "string",
          description: "The start value of the chosen slot, copied from get_available_slots.",
        },
        issue_summary: {
          type: "string",
          maxLength: TEXT_MAX,
          description: "One or two sentences on what the customer needs.",
        },
      },
      required: ["kind", "slot_start", "issue_summary"],
    },
  },
  {
    name: "escalate_to_owner",
    description:
      "Alert the owner right away about an emergency, an upset customer, or anything you cannot handle.",
    input_schema: {
      type: "object",
      properties: {
        reason: { type: "string", maxLength: TEXT_MAX, description: "Why the owner is needed." },
        urgency: { type: "string", enum: [...URGENCIES] },
        summary: {
          type: "string",
          maxLength: TEXT_MAX,
          description: "What the customer said and what has happened so far.",
        },
      },
      required: ["reason", "urgency", "summary"],
    },
  },
];

function fail(error: string, wrote = false): ToolResult {
  return { ok: false, wrote, result: { error } };
}

function done(result: Record<string, unknown>, wrote: boolean): ToolResult {
  return { ok: true, wrote, result };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

// Strings (and numbers, for a ZIP typed as one) collapsed to a single trimmed
// line; anything else is empty.
function textOf(value: unknown): string {
  if (typeof value === "number") return String(value);
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function isKind(value: unknown): value is SlotKind {
  return typeof value === "string" && (KINDS as readonly string[]).includes(value);
}

function businessName(profile: AgentProfile): string {
  return profile.display_name || "Fieldworx";
}

// Starts of this business's scheduled appointments on the same resource
// (phone_call -> the owner's call line; visits -> the technician) across the
// range the slots cover. null on a database error.
async function bookedStarts(
  ctx: ToolContext,
  kind: SlotKind,
  slots: Slot[],
): Promise<string[] | null> {
  if (slots.length === 0) return [];
  const { data, error } = await ctx.supabase
    .from("appointments")
    .select("starts_at")
    .eq("business_id", ctx.businessId)
    .eq("status", "scheduled")
    .eq("resource", kind === "phone_call" ? "call" : "visit")
    .gte("starts_at", slots[0].start)
    .lte("starts_at", slots[slots.length - 1].start);
  if (error) return null;
  return (data ?? []).map((row) => row.starts_at as string);
}

async function getAvailableSlots(
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  if (!isKind(input.kind)) {
    return fail("kind must be service_visit, estimate_visit, or phone_call.");
  }
  const slots = buildSlots(input.kind, ctx.now);
  const booked = await bookedStarts(ctx, input.kind, slots);
  if (!booked) return fail("Couldn't check availability right now.");
  const open = openSlots(slots, booked);
  return done({ slots: open.map((s) => ({ start: s.start, label: s.label })) }, false);
}

function checkServiceArea(
  input: Record<string, unknown>,
  ctx: ToolContext,
): ToolResult {
  const zip = normalizeZip(textOf(input.zip));
  if (!zip) return fail(ZIP_MESSAGE);
  return done({ zip, in_area: zipInArea(zip, ctx.profile.service_zip_prefixes) }, false);
}

async function saveCustomerDetails(
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const name = textOf(input.name);
  if (name.length < 1 || name.length > NAME_MAX) {
    return fail("A name of 1 to 100 characters is required.");
  }
  const street = textOf(input.street_address);
  if (street.length > ADDRESS_MAX) return fail("That street address is too long.");
  const zipText = textOf(input.zip);
  const zip = zipText ? normalizeZip(zipText) : null;
  if (zipText && !zip) return fail(ZIP_MESSAGE);
  const emailText = textOf(input.email);
  if (emailText && !isValidEmail(emailText)) {
    return fail(
      "That email address doesn't look right. Ask the customer to re-check it.",
    );
  }

  const { supabase, businessId } = ctx;
  let wrote = false;

  // The customer is whoever owns this phone number at this business.
  const { data: existing, error: findError } = await supabase
    .from("customers")
    .select("id, email")
    .eq("business_id", businessId)
    .eq("phone", ctx.customerNumber)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (findError) return fail(SAVE_FAILED);

  let customerId: string;
  let email: string | null = existing?.email ?? null;
  if (existing) {
    const { error } = await supabase
      .from("customers")
      .update(emailText ? { name, email: emailText } : { name })
      .eq("id", existing.id)
      .eq("business_id", businessId);
    if (error) return fail(SAVE_FAILED);
    customerId = existing.id;
    if (emailText) email = emailText;
  } else {
    const { data: created, error } = await supabase
      .from("customers")
      .insert({
        business_id: businessId,
        name,
        phone: ctx.customerNumber,
        email: emailText || null,
        source: "agent_inbound",
      })
      .select("id")
      .single();
    if (error) return fail(SAVE_FAILED);
    customerId = created.id;
    email = emailText || null;
  }
  wrote = true;

  // A service location only when both halves of the address were given and
  // this customer does not already have that exact address.
  let hasAddress = false;
  if (street && zip) {
    const address = `${street}, ${zip}`;
    const { data: same, error: sameError } = await supabase
      .from("service_locations")
      .select("id")
      .eq("business_id", businessId)
      .eq("customer_id", customerId)
      .eq("address", address)
      .limit(1)
      .maybeSingle();
    if (sameError) return fail(SAVE_FAILED, wrote);
    if (!same) {
      const { error } = await supabase
        .from("service_locations")
        .insert({ business_id: businessId, customer_id: customerId, address });
      if (error) return fail(SAVE_FAILED, wrote);
    }
    hasAddress = true;
  } else {
    const { data: onRecord, error } = await supabase
      .from("service_locations")
      .select("id")
      .eq("business_id", businessId)
      .eq("customer_id", customerId)
      .limit(1)
      .maybeSingle();
    if (error) return fail(SAVE_FAILED, wrote);
    hasAddress = onRecord !== null;
  }

  const { error: leadError } = await supabase
    .from("leads")
    .update({ customer_id: customerId })
    .eq("id", ctx.leadId)
    .eq("business_id", businessId);
  if (leadError) return fail(SAVE_FAILED, wrote);

  return done({ saved: true, has_address: hasAddress, has_email: Boolean(email) }, true);
}

async function bookAppointment(
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const kind = input.kind;
  if (!isKind(kind)) {
    return fail("kind must be service_visit, estimate_visit, or phone_call.");
  }
  const slotStart = textOf(input.slot_start);
  const issue = textOf(input.issue_summary).slice(0, TEXT_MAX);
  if (!slotStart || !issue) {
    return fail("slot_start and issue_summary are required.");
  }
  const { supabase, businessId, profile } = ctx;

  // a. the requested instant must still be open
  const slots = buildSlots(kind, ctx.now);
  const booked = await bookedStarts(ctx, kind, slots);
  if (!booked) return fail(BOOKING_FAILED);
  const wanted = new Date(slotStart).getTime();
  const slot = openSlots(slots, booked).find(
    (s) => new Date(s.start).getTime() === wanted,
  );
  if (!slot) return fail(SLOT_UNAVAILABLE);

  // b-d. what must be on file before this lead can hold this appointment
  const onFile = await loadOnFile(supabase, { businessId, leadId: ctx.leadId });
  const customer = onFile.customer;
  if (!customer || !customer.name) return fail("Save the customer's name first.");

  const isVisit = kind !== "phone_call";
  const location = onFile.location;
  if (
    isVisit &&
    (!location || !onFile.zip || !zipInArea(onFile.zip, profile.service_zip_prefixes))
  ) {
    return fail("A visit needs a service address inside the service area.");
  }

  const already = onFile.appointments.find((a) => a.kind === kind);
  if (already) {
    return fail(`This customer already has a ${kindLabel(kind)} booked for ${already.label}.`);
  }

  const { data: appointment, error: appointmentError } = await supabase
    .from("appointments")
    .insert({
      business_id: businessId,
      lead_id: ctx.leadId,
      customer_id: customer.id,
      conversation_id: ctx.conversationId,
      kind,
      starts_at: slot.start,
      ends_at: slot.end,
      notes: issue,
    })
    .select("id")
    .single();
  if (appointmentError) {
    return fail(
      appointmentError.code === "23505"
        ? "That slot was just taken. Call get_available_slots again."
        : BOOKING_FAILED,
    );
  }

  // Visits also get a work order, linked both ways.
  const leadPatch: Record<string, unknown> = { status: "booked" };
  if (isVisit) {
    const { data: workOrder, error: workOrderError } = await supabase
      .from("work_orders")
      .insert({
        business_id: businessId,
        customer_id: customer.id,
        service_location_id: location?.id ?? null,
        lead_id: ctx.leadId,
        status: "scheduled",
        type: kind === "service_visit" ? "service" : "estimate",
        scheduled_at: slot.start,
        source: "agent_inbound",
        notes: issue,
      })
      .select("id")
      .single();
    if (workOrderError) {
      // compensating delete: no appointment without its work order
      const { error: undoError } = await supabase
        .from("appointments")
        .delete()
        .eq("id", appointment.id)
        .eq("business_id", businessId);
      if (undoError) console.error("[tools] booking cleanup failed");
      return fail(BOOKING_FAILED, Boolean(undoError));
    }
    const { error: linkError } = await supabase
      .from("appointments")
      .update({ work_order_id: workOrder.id })
      .eq("id", appointment.id)
      .eq("business_id", businessId);
    if (linkError) console.error("[tools] appointment link failed");
    leadPatch.work_order_id = workOrder.id;
  }

  const { error: leadError } = await supabase
    .from("leads")
    .update(leadPatch)
    .eq("id", ctx.leadId)
    .eq("business_id", businessId);
  if (leadError) console.error("[tools] lead update failed");

  // Emails never fail the booking: sendEmail records its own failures.
  const label = kindLabel(kind);
  const shop = businessName(profile);
  const base = {
    businessId,
    conversationId: ctx.conversationId,
    leadId: ctx.leadId,
    appointmentId: appointment.id as string,
  };

  const ownerTo = profile.owner_email;
  const ownerSend: Promise<EmailStatus | "no_owner_email"> = ownerTo
    ? (() => {
        const mail = bookingOwnerEmail({
          kindLabel: label,
          slotLabel: slot.label,
          customerName: customer.name,
          customerPhone: ctx.customerNumber,
          address: location?.address ?? null,
          email: customer.email,
          issue,
          businessName: shop,
        });
        return sendEmail(supabase, {
          ...base,
          audience: "owner",
          to: ownerTo,
          template: "booking_owner",
          ...mail,
        }).then((r) => r.status);
      })()
    : Promise.resolve("no_owner_email");

  const customerTo = customer.email;
  const customerSend: Promise<EmailStatus | "no_email"> = customerTo
    ? (() => {
        const mail = bookingCustomerEmail({
          kindLabel: label,
          slotLabel: slot.label,
          customerName: customer.name,
          businessName: shop,
          isDemo: profile.is_demo === true,
        });
        return sendEmail(supabase, {
          ...base,
          audience: "customer",
          to: customerTo,
          template: "booking_customer",
          ...mail,
        }).then((r) => r.status);
      })()
    : Promise.resolve("no_email");

  const [owner, customerStatus] = await Promise.all([ownerSend, customerSend]);
  return done(
    { booked: true, kind, label: slot.label, emails: { owner, customer: customerStatus } },
    true,
  );
}

async function escalateToOwner(
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const reason = textOf(input.reason).slice(0, TEXT_MAX);
  const summary = textOf(input.summary).slice(0, TEXT_MAX);
  const urgency = input.urgency;
  if (!reason || !summary) return fail("A reason and a summary are required.");
  if (typeof urgency !== "string" || !(URGENCIES as readonly string[]).includes(urgency)) {
    return fail('urgency must be "emergency", "high", or "normal".');
  }

  const { error } = await ctx.supabase
    .from("leads")
    .update({ status: "escalated", urgency })
    .eq("id", ctx.leadId)
    .eq("business_id", ctx.businessId);
  if (error) return fail("Couldn't alert the owner right now. Please try again.");

  const ownerTo = ctx.profile.owner_email;
  let ownerStatus: EmailStatus | "no_owner_email" = "no_owner_email";
  if (ownerTo) {
    const mail = escalationOwnerEmail({
      urgency,
      reason,
      summary,
      customerPhone: ctx.customerNumber,
      businessName: businessName(ctx.profile),
    });
    ownerStatus = (
      await sendEmail(ctx.supabase, {
        businessId: ctx.businessId,
        conversationId: ctx.conversationId,
        leadId: ctx.leadId,
        audience: "owner",
        to: ownerTo,
        template: "escalation_owner",
        ...mail,
      })
    ).status;
  }
  return done({ escalated: true, owner_email: ownerStatus }, true);
}

// Runs one tool call. Never throws: unknown tools, bad input and unexpected
// errors all come back as ok:false with a short message the model can relay.
export async function executeTool(
  name: string,
  input: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  try {
    const known = TOOL_DEFINITIONS.some((tool) => tool.name === name);
    if (!known) return fail("Unknown tool.");
    const args = asRecord(input);
    if (!args) return fail("Invalid tool input.");

    switch (name) {
      case "get_available_slots":
        return await getAvailableSlots(args, ctx);
      case "check_service_area":
        return checkServiceArea(args, ctx);
      case "save_customer_details":
        return await saveCustomerDetails(args, ctx);
      case "book_appointment":
        return await bookAppointment(args, ctx);
      case "escalate_to_owner":
        return await escalateToOwner(args, ctx);
      default:
        return fail("Unknown tool.");
    }
  } catch {
    console.error("[tools] unexpected error");
    return fail("Something went wrong. Please try again.");
  }
}
