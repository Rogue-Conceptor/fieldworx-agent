import "server-only";
import type Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { HISTORY_LIMIT } from "./config";
import { stripForHistory } from "./format";
import { OPT_IN_TEXT } from "./keywords";

export type Turn = { role: "user" | "assistant"; content: string };
export type HistoryRow = { direction: string; body: string | null };

// Pure turn-building logic: oldest-first message rows in, alternating turns
// out, always starting AND ending with a user turn. The opt-in confirmation
// is compliance boilerplate, not conversation, so it never reaches the model.
export function buildTurns(rows: HistoryRow[], prefix: string): Turn[] {
  const turns: Turn[] = [];
  for (const row of rows) {
    const isInbound = row.direction === "inbound";
    if (!isInbound && (row.body ?? "").trim() === OPT_IN_TEXT) continue;

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
  while (turns.length > 0 && turns[turns.length - 1].role === "assistant") turns.pop();

  return turns;
}

// Last HISTORY_LIMIT messages of a conversation as Anthropic message params.
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

  const rows = ((data ?? []) as HistoryRow[]).reverse();
  return buildTurns(rows, prefix);
}
