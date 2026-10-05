import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { formatCentral } from "@/lib/format/time";
import { maskPhone } from "@/lib/format/phone";
import AutoRefresh from "./AutoRefresh";
import Badge, { statusTone } from "./Badge";

export const dynamic = "force-dynamic";

type ConversationRow = {
  id: string;
  customer_number: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  lead_id: string;
};

function tally(values: (string | null)[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) {
    if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

export default async function ConversationsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return (
      <main className="min-h-screen bg-neutral-50 text-neutral-900">
        <div className="mx-auto max-w-3xl px-4 py-10">
          <p>
            Not logged in — go to{" "}
            <Link href="/login" className="text-sky-700 underline">
              /login
            </Link>
          </p>
        </div>
      </main>
    );
  }

  // Everything below runs as the logged-in user, so RLS decides what is seen.
  const { data, error } = await supabase
    .from("conversations")
    .select("id, customer_number, status, created_at, updated_at, lead_id")
    .order("updated_at", { ascending: false })
    .limit(50);
  const conversations = (data ?? []) as ConversationRow[];

  // Counts come from three batched reads rather than one query per row. The
  // API caps a response at 1000 rows, which is far above 50 demo conversations.
  const ids = conversations.map((c) => c.id);
  const leadIds = Array.from(new Set(conversations.map((c) => c.lead_id)));
  const [messageRes, appointmentRes, leadRes] =
    conversations.length === 0
      ? [null, null, null]
      : await Promise.all([
          supabase.from("messages").select("conversation_id").in("conversation_id", ids),
          supabase
            .from("appointments")
            .select("lead_id")
            .in("lead_id", leadIds)
            .eq("status", "scheduled"),
          supabase.from("leads").select("id, status").in("id", leadIds),
        ]);

  const messageCounts = tally(
    ((messageRes?.data ?? []) as { conversation_id: string }[]).map((m) => m.conversation_id),
  );
  const appointmentCounts = tally(
    ((appointmentRes?.data ?? []) as { lead_id: string | null }[]).map((a) => a.lead_id),
  );
  const leadStatus = new Map(
    ((leadRes?.data ?? []) as { id: string; status: string }[]).map((l) => [l.id, l.status]),
  );
  const loadError = error ?? messageRes?.error ?? appointmentRes?.error ?? leadRes?.error;

  return (
    <main className="min-h-screen bg-neutral-50 text-neutral-900">
      <div className="mx-auto max-w-4xl px-4 py-6">
        <header className="mb-6 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">Conversations</h1>
            <p className="mt-1 text-sm text-neutral-600">
              Logged in as {user.email} ·{" "}
              <Link href="/login" className="text-sky-700 underline">
                Login page
              </Link>
            </p>
          </div>
          <AutoRefresh />
        </header>

        {loadError && (
          <p className="mb-4 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
            Could not load everything: {loadError.message}
          </p>
        )}

        {conversations.length === 0 && !loadError ? (
          <p className="rounded border border-neutral-200 bg-white px-4 py-6 text-sm text-neutral-600">
            No conversations yet.
          </p>
        ) : (
          <ul className="space-y-2">
            {conversations.map((c) => (
              <li key={c.id}>
                <Link
                  href={`/conversations/${c.id}`}
                  className="block rounded-lg border border-neutral-200 bg-white px-4 py-3 shadow-sm transition hover:border-sky-300 hover:shadow"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-sm font-semibold">
                      {maskPhone(c.customer_number)}
                    </span>
                    <Badge tone={statusTone(c.status)}>{c.status}</Badge>
                    <span className="text-xs text-neutral-500">lead</span>
                    <Badge tone={statusTone(leadStatus.get(c.lead_id))}>
                      {leadStatus.get(c.lead_id) ?? "—"}
                    </Badge>
                  </div>
                  <dl className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-xs text-neutral-600">
                    <div>
                      <dt className="inline text-neutral-400">Started </dt>
                      <dd className="inline">{formatCentral(c.created_at, "datetime")}</dd>
                    </div>
                    <div>
                      <dt className="inline text-neutral-400">Last activity </dt>
                      <dd className="inline">{formatCentral(c.updated_at, "time")}</dd>
                    </div>
                    <div>
                      <dt className="inline text-neutral-400">Messages </dt>
                      <dd className="inline">{messageCounts.get(c.id) ?? 0}</dd>
                    </div>
                    <div>
                      <dt className="inline text-neutral-400">Appointments </dt>
                      <dd className="inline">{appointmentCounts.get(c.lead_id) ?? 0}</dd>
                    </div>
                  </dl>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
