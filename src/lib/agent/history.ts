import "server-only";
import type Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { HISTORY_LIMIT } from "./config";
import { stripForHistory } from "./format";

type Turn = { role: "user" | "assistant"; content: string };

// Last HISTORY_LIMIT messages of a conversation as Anthropic message params,
// oldest first, alternating roles, starting with a user turn.
export async function loadHistory(
  supabase: SupabaseClient,
  conversationId: string,
  prefix: string,
): Promise<Anthropic.MessageParam[]> {
  const { data, error } = await supabase
    .from("messages")
    .select("direction, body")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(HISTORY_LIMIT);
  if (error) throw error;

  const rows = ((data ?? []) as { direction: string; body: string | null }[]).reverse();

  const turns: Turn[] = [];
  for (const row of rows) {
    const isInbound = row.direction === "inbound";
    const content = isInbound
      ? (row.body ?? "").trim()
      : stripForHistory(row.body ?? "", prefix);
    if (!content) continue; // the API rejects empty turns

    const role = isInbound ? "user" : "assistant";
    const last = turns[turns.length - 1];
    if (last && last.role === role) {
      last.content += "\n" + content;
    } else {
      turns.push({ role, content });
    }
  }

  while (turns.length > 0 && turns[0].role === "assistant") turns.shift();

  return turns;
}
