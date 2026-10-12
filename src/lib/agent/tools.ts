import "server-only";
import type Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isValidEmail, normalizeZip, zipInArea } from "./area";
import { buildSlots, openSlots, slotLabel, type Slot, type SlotKind } from "./clock";
import {
  bookingCustomerEmail,
  bookingOwnerEmail,
  escalationOwnerEmail,
  kindLabel,
} from "./emails";
import { EMAIL_CAP_CODES, sendEmail, type EmailStatus } from "./notify";
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
      "Save what the customer has told you: their name, and for visits their street address and ZIP, and an email only if they gave one or agreed to the one on file. Pass the name exactly as On file shows it unless the customer corrects it. Safe to call again to add details. Saving an email records their permission to email booking confirmations to that address and sends any not yet sent; the result's confirmation_email says what happened.",
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
      "Book the appointment the customer chose. slot must be the time exactly as you offered it, for example \"Mon Oct 5, 9-11 AM\" (or its ISO start time from get_available_slots), and it must be open for the same kind. The customer's name must be saved first, and a visit also needs a saved street address and ZIP inside the service area.",
    input_schema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: [...KINDS] },
        slot: {
          type: "string",
          description:
            "The chosen time, exactly as you offered it, for example \"Mon Oct 5, 9-11 AM\". An ISO start time from get_available_slots also works.",
        },
        issue_summary: {
          type: "string",
          maxLength: TEXT_MAX,
          description: "One or two sentences on what the customer needs.",
        },
      },
      required: ["kind", "slot", "issue_summary"],
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

// Labels compare ignoring case and spacing, with any dash alike (hyphen, en
// dash, em dash): "mon oct 5, 9 – 11 am" is "Mon Oct 5, 9-11 AM".
function normalizeLabel(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‐-―−]/g, "-")
    .replace(/\s*-\s*/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

const ISO_START = /^\d{4}-\d{2}-\d{2}T/;

// The open slot a customer-facing time refers to: the label as it was offered,
// or an ISO start time. Only ISO-shaped text is parsed as a date, because a
// label like "Mon Oct 5, 9-11 AM" can parse to a nonsense date.
function findSlot(open: Slot[], requested: string): Slot | undefined {
  if (ISO_START.test(requested)) {
    const wanted = Date.parse(requested);
    return open.find((s) => Date.parse(s.start) === wanted);
  }
  const wanted = normalizeLabel(requested);
  return open.find((s) => normalizeLabel(s.label) === wanted);
}

export type ConfirmationEmail =
  | "sent"
  | "logged"
  | "already_sent"
  | "no_bookings"
  | "failed"
  | "not_sent_limit"
  | "not_requested";

// One confirmation attempt: what sendEmail recorded, or "capped" when a cap
// held it back (the notification row says "logged" but nothing was sent).
type ConfirmationSend = EmailStatus | "capped";

type ConfirmationRun = {
  appointments: number; // scheduled appointments on this lead
  results: ConfirmationSend[]; // one per confirmation this call attempted
  lookupFailed: boolean;
};

// What the model is told about the confirmation email after a save. A lookup
// error counts as "failed": the confirmation could not be sent. With several
// results the worst one wins: failed, then not_sent_limit (a cap held a
// confirmation back), then logged, then sent.
export function confirmationOutcome(args: {
  requested: boolean;
  appointments: number;
  results: ConfirmationSend[];
  lookupFailed: boolean;
}): ConfirmationEmail {
  if (!args.requested) return "not_requested";
  if (args.lookupFailed) return "failed";
  if (args.appointments === 0) return "no_bookings";
  if (args.results.length === 0) return "already_sent";
  if (args.results.includes("failed")) return "failed";
  if (args.results.includes("capped")) return "not_sent_limit";
  return args.results.includes("logged") ? "logged" : "sent";
}

// An email that arrives after the booking still gets its confirmation: every
// scheduled appointment on this lead that has no sent or logged customer
// notification to this same address is confirmed to it. A failed earlier send,
// one to a different address, or one a cap held back (its row is "logged" but
// carries a cap error_code) does not count, so it is tried again. Lookup
// errors mean none are sent; they never fail the save.
async function sendMissingConfirmations(
  ctx: ToolContext,
  customerName: string,
  to: string,
): Promise<ConfirmationRun> {
  const { supabase, businessId, profile } = ctx;
  const { data: appointments, error: appointmentError } = await supabase
    .from("appointments")
    .select("id, kind, starts_at")
    .eq("lead_id", ctx.leadId)
    .eq("business_id", businessId)
    .eq("status", "scheduled")
    .order("starts_at", { ascending: true });
  if (appointmentError || !appointments) {
    console.error("[tools] confirmation lookup failed");
    return { appointments: 0, results: [], lookupFailed: true };
  }
  if (appointments.length === 0) {
    return { appointments: 0, results: [], lookupFailed: false };
  }

  const { data: existing, error: notificationError } = await supabase
    .from("notifications")
    .select("appointment_id, recipient, error_code")
    .eq("business_id", businessId)
    .eq("audience", "customer")
    .in("status", ["sent", "logged"])
    .in(
      "appointment_id",
      appointments.map((a) => a.id as string),
    );
  if (notificationError) {
    console.error("[tools] confirmation lookup failed");
    return { appointments: appointments.length, results: [], lookupFailed: true };
  }
  const wanted = to.toLowerCase();
  const capCodes: readonly string[] = EMAIL_CAP_CODES;
  const confirmed = new Set(
    (existing ?? [])
      .filter((n) => String(n.recipient ?? "").toLowerCase() === wanted)
      .filter((n) => !capCodes.includes(String(n.error_code ?? "")))
      .map((n) => n.appointment_id as string),
  );

  const results: ConfirmationSend[] = [];
  for (const appointment of appointments) {
    if (confirmed.has(appointment.id as string)) continue;
    const kind = appointment.kind as SlotKind;
    const mail = bookingCustomerEmail({
      kindLabel: kindLabel(kind),
      slotLabel: slotLabel(kind, appointment.starts_at as string),
      customerName,
      businessName: businessName(profile),
      isDemo: profile.is_demo === true,
    });
    const result = await sendEmail(supabase, {
      businessId,
      conversationId: ctx.conversationId,
      leadId: ctx.leadId,
      appointmentId: appointment.id as string,
      audience: "customer",
      to,
      template: "booking_customer",
      ...mail,
    });
    results.push(result.capped ? "capped" : result.status);
  }
  return { appointments: appointments.length, results, lookupFailed: false };
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

  // One customer per person: among this business's customers with this phone
  // number, the one with the same name (ignoring case and spacing). That row is
  // never renamed, and an email is never copied in from another row. The name
  // is compared in code, not with ilike, so % and _ in a name stay literal.
  const { data: sameNumber, error: findError } = await supabase
    .from("customers")
    .select("id, name, email")
    .eq("business_id", businessId)
    .eq("phone", ctx.customerNumber)
    .order("updated_at", { ascending: false });
  if (findError) return fail(SAVE_FAILED);
  const wantedName = name.toLowerCase();
  const existing = (sameNumber ?? []).find(
    (row) => textOf(row.name).toLowerCase() === wantedName,
  );

  let customerId: string;
  let customerName = name;
  let email: string | null;
  if (existing) {
    email = (existing.email as string | null) ?? null;
    if (emailText && emailText !== email) {
      const { error } = await supabase
        .from("customers")
        .update({ email: emailText })
        .eq("id", existing.id)
        .eq("business_id", businessId);
      if (error) return fail(SAVE_FAILED);
      email = emailText;
    }
    customerId = existing.id;
    customerName = existing.name as string;
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

  // An email given in this conversation is the customer's permission to email
  // confirmations to that address. Both consent columns are written together
  // (the table's pair rule) and only when the address is new for this
  // conversation, so the original timestamp survives a repeated save.
  if (emailText) {
    const { data: conversation, error: conversationError } = await supabase
      .from("conversations")
      .select("email_consent_address")
      .eq("id", ctx.conversationId)
      .eq("business_id", businessId)
      .maybeSingle();
    if (conversationError || !conversation) {
      console.error("[tools] consent lookup failed");
      return fail(SAVE_FAILED, wrote);
    }
    const recorded = (conversation.email_consent_address as string | null) ?? null;
    if (recorded === null || recorded.toLowerCase() !== emailText.toLowerCase()) {
      const { data: updated, error: consentError } = await supabase
        .from("conversations")
        .update({
          email_consent_address: emailText,
          email_consent_at: new Date().toISOString(),
        })
        .eq("id", ctx.conversationId)
        .eq("business_id", businessId)
        .select("id");
      // An update that matches no row is not an error, so count the rows.
      if (consentError || !updated || updated.length === 0) {
        console.error("[tools] consent record failed");
        return fail(SAVE_FAILED, wrote);
      }
    }
  }

  // Every save that carries an email sends whatever confirmations are still
  // missing for that address; with nothing missing it sends nothing.
  const confirmation: ConfirmationRun = emailText
    ? await sendMissingConfirmations(ctx, customerName, emailText)
    : { appointments: 0, results: [], lookupFailed: false };

  return done(
    {
      saved: true,
      has_address: hasAddress,
      has_email: Boolean(email),
      confirmation_email: confirmationOutcome({
        requested: emailText !== "",
        ...confirmation,
      }),
      confirmations_sent: confirmation.results.filter(
        (status) => status !== "failed" && status !== "capped",
      ).length,
    },
    true,
  );
}

async function bookAppointment(
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const kind = input.kind;
  if (!isKind(kind)) {
    return fail("kind must be service_visit, estimate_visit, or phone_call.");
  }
  const requestedSlot = textOf(input.slot);
  const issue = textOf(input.issue_summary).slice(0, TEXT_MAX);
  if (!requestedSlot || !issue) {
    return fail("slot and issue_summary are required.");
  }
  const { supabase, businessId, profile } = ctx;

  // a. the requested time must be one of the slots still open for this kind
  const slots = buildSlots(kind, ctx.now);
  const booked = await bookedStarts(ctx, kind, slots);
  if (!booked) return fail(BOOKING_FAILED);
  const slot = findSlot(openSlots(slots, booked), requestedSlot);
  if (!slot) return fail(SLOT_UNAVAILABLE);

  // b-d. what must be on file before this lead can hold this appointment
  const onFile = await loadOnFile(supabase, {
    businessId,
    leadId: ctx.leadId,
    customerNumber: ctx.customerNumber,
  });
  const customer = onFile.customer;
  // An unconfirmed customer (found only by phone) is not this lead's customer
  // until save_customer_details links it.
  if (!customer || !customer.confirmed || !customer.name) {
    return fail("Save the customer's name first.");
  }

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

  // The customer is emailed only at the address they agreed to in this
  // conversation. An email on their record is not permission. A lookup error
  // counts as no permission, and never fails the booking.
  const { data: consentRow, error: consentError } = await supabase
    .from("conversations")
    .select("email_consent_address")
    .eq("id", ctx.conversationId)
    .eq("business_id", businessId)
    .maybeSingle();
  if (consentError) console.error("[tools] consent lookup failed");
  const customerTo: string | null = consentError
    ? null
    : ((consentRow?.email_consent_address as string | null | undefined) ?? null);
  const customerSend: Promise<EmailStatus | "no_consent" | "not_sent_limit"> = customerTo
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
        }).then((r) => (r.capped ? "not_sent_limit" : r.status));
      })()
    : Promise.resolve("no_consent");

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
