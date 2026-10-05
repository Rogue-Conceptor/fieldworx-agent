import "server-only";
import type { SlotKind } from "./clock";

// Pure plain-text templates; nothing here sends anything.
export type EmailContent = { subject: string; text: string };

export function kindLabel(kind: SlotKind): string {
  switch (kind) {
    case "service_visit":
      return "service visit";
    case "estimate_visit":
      return "estimate visit";
    case "phone_call":
      return "phone call";
  }
}

export function bookingOwnerEmail(args: {
  kindLabel: string;
  slotLabel: string;
  customerName: string;
  customerPhone: string;
  address: string | null;
  email: string | null;
  issue: string;
  businessName: string;
}): EmailContent {
  return {
    subject: `New ${args.kindLabel}: ${args.slotLabel}`,
    text: [
      `Who: ${args.customerName}`,
      `Phone: ${args.customerPhone}`,
      `Address: ${args.address || "not given"}`,
      `Email: ${args.email || "not given"}`,
      `Issue: ${args.issue}`,
      "",
      `Booked by the ${args.businessName} text assistant.`,
    ].join("\n"),
  };
}

export function bookingCustomerEmail(args: {
  kindLabel: string;
  slotLabel: string;
  customerName: string;
  businessName: string;
  isDemo: boolean;
}): EmailContent {
  const lines = [
    `Hi ${args.customerName},`,
    "",
    `Your ${args.kindLabel} with ${args.businessName} is booked for ${args.slotLabel}.`,
  ];
  if (args.isDemo) {
    lines.push(
      "",
      "This is a demo booking made by an AI assistant built by Jerry King. No technician will be sent and no appointment is real.",
    );
  }
  lines.push("", `- ${args.businessName}`);
  return {
    subject: `${args.businessName}: your ${args.kindLabel} for ${args.slotLabel}`,
    text: lines.join("\n"),
  };
}

export function escalationOwnerEmail(args: {
  urgency: string;
  reason: string;
  summary: string;
  customerPhone: string;
  businessName: string;
}): EmailContent {
  return {
    subject: `[${args.urgency.toUpperCase()}] Customer needs attention`,
    text: [
      `Reason: ${args.reason}`,
      `Summary: ${args.summary}`,
      `Customer phone: ${args.customerPhone}`,
      "",
      `Flagged by the ${args.businessName} text assistant.`,
    ].join("\n"),
  };
}
