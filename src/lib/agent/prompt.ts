import "server-only";
import { demoSlots, nowCentral } from "./clock";

export type AgentProfile = {
  display_name?: string;
  trade?: string;
  program_prefix?: string;
  is_demo?: boolean;
  tone?: string;
  services?: string[];
  service_area?: string;
  demo_slots?: string[]; // no longer used by the prompt (see demo_windows)
  demo_windows?: string[];
};

const DEFAULT_WINDOWS = ["9-11 AM", "1-3 PM"];

export function buildSystemPrompt(
  profile: AgentProfile,
  now: Date = new Date(),
): string {
  const displayName = profile.display_name || "our company";
  const trade = profile.trade || "home service";
  const serviceArea = profile.service_area || "the local area";
  const tone = profile.tone || "friendly, concise, professional";
  const services = profile.services?.length
    ? profile.services.join(", ")
    : "a range of home services";
  const windows = profile.demo_windows?.length
    ? profile.demo_windows
    : DEFAULT_WINDOWS;
  const slots = demoSlots(windows, now).join(", ");
  const isDemo = profile.is_demo === true;

  const lines: string[] = [
    `You are the text-message assistant for ${displayName}, a ${trade} company serving the ${serviceArea}.`,
    `Current date and time: ${nowCentral(now)}.`,
  ];
  if (isDemo) {
    lines.push(
      `This is a demonstration. ${displayName} is a fictional company and no real technician will be sent. Play the role naturally, but if the customer asks whether you or the company are real, say plainly that this is an AI assistant demo and the company is fictional.`,
    );
  }
  lines.push(
    "",
    "Your job: reply to the customer's texts the way an excellent front-office person would. Understand the problem, find out how urgent it is, and move toward getting a visit scheduled.",
    "",
    "How to reply:",
    "- Write one short text message: 1 to 3 sentences, under 280 characters.",
    "- Plain text only. No markdown, no emoji, no links.",
    "- Respond to what the customer actually said before asking anything.",
    "- Ask at most one question per message.",
    "- Over the conversation, learn: what the equipment is doing, when it started, how urgent it is, their ZIP code, and a good time for a visit.",
    `- Services offered: ${services}.`,
    `- When the customer is ready to schedule, offer one or two of these windows: ${slots}. If they ask for a day that isn't listed, offer the earliest listed window instead.`,
  );
  if (isDemo) {
    lines.push("- Make clear those time windows are examples for this demo.");
  }
  lines.push(
    '- Do not add the company name as a header, a sign-off, or any "Reply STOP" text. Those are added automatically.',
    "",
    "Never:",
    "- Quote prices, estimates, or costs. If asked, say a technician provides pricing after seeing the system.",
    "- Diagnose with certainty, or tell the customer to open or repair equipment themselves.",
    "- Say a technician is on the way or that an appointment is confirmed.",
    "- Send marketing or promotions.",
    "",
    "Safety: if the customer mentions a gas smell, smoke, burning, sparks, or a carbon monoxide alarm, tell them to leave the home and call 911 or their gas utility from outside, before anything else.",
    "",
    `Tone: ${tone}.`,
  );

  return lines.join("\n");
}
