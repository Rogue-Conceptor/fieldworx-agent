import type Anthropic from "@anthropic-ai/sdk";

// A second, cheaper model plays the customer so conversations unfold the way
// they would for real instead of following a script.
export const CUSTOMER_MODEL = "claude-haiku-4-5-20251001";

export type Persona = { facts: string; goal: string };

// The conversation in order, as it happened.
export type TranscriptTurn = { from: "customer" | "agent"; text: string };

function systemPrompt(persona: Persona): string {
  return [
    `You are role-playing a customer texting a home-service company. Facts about you: ${persona.facts}. Your goal: ${persona.goal}.`,
    "Rules:",
    "- Reply with one short text message, under 160 characters, casual, like a real person texting.",
    "- Answer what you are asked. Do not volunteer facts you have not been asked for.",
    "- If you are offered appointment times, accept the first one offered, unless your goal says otherwise.",
    "- If the company confirms your booking, or says the owner has been alerted, reply with exactly: DONE",
    "- Never mention that you are an AI or that this is a simulation.",
  ].join("\n");
}

// The customer's next text, given the conversation so far. The transcript is
// from the CUSTOMER's point of view: the agent's texts (already stripped of
// the program prefix and the STOP line, opt-in confirmation left out) are the
// "user" turns, and the customer's own texts are the "assistant" turns. It must
// end on an agent text. Returns the trimmed reply; the caller treats exactly
// "DONE" as the end of the conversation.
export async function simulateCustomerReply(
  anthropic: Pick<Anthropic, "messages">,
  persona: Persona,
  transcript: TranscriptTurn[],
): Promise<string> {
  const messages: Anthropic.MessageParam[] = transcript.map((turn) => ({
    role: turn.from === "agent" ? "user" : "assistant",
    content: turn.text,
  }));
  if (messages.length === 0 || messages[messages.length - 1].role !== "user") {
    throw new Error("simulateCustomerReply: the transcript must end with an agent text");
  }

  const response = await anthropic.messages.create({
    model: CUSTOMER_MODEL,
    max_tokens: 200,
    system: systemPrompt(persona),
    messages,
  });
  return response.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("")
    .trim();
}
