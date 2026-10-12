import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { formatCentral } from "@/lib/format/time";
import { maskPhone } from "@/lib/format/phone";
import AutoRefresh from "../AutoRefresh";
import Badge, { deliveryTone, outcomeTone, statusTone } from "../Badge";

export const dynamic = "force-dynamic";

// The opt-in confirmation is recognised by its opening words. Its full text
// lives in a server-only module that this page does not import.
const OPT_IN_PREFIX = "Fieldworx Demo: Thanks for texting the Fieldworx Demo AI assistant.";

const KIND_LABEL: Record<string, string> = {
  service_visit: "service visit",
  estimate_visit: "estimate visit",
  phone_call: "phone call",
};

type Conversation = {
  id: string;
  customer_number: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  lead_id: string;
};
type Message = {
  id: string;
  direction: string;
  body: string | null;
  created_at: string;
  delivery_status: string | null;
  delivery_error_code: string | null;
  delivery_updated_at: string | null;
};
type ToolCall = {
  name: string;
  ok: boolean;
  wrote: boolean;
  ms: number;
  input: unknown;
  result: unknown;
};
type Run = {
  id: string;
  inbound_message_id: string;
  outcome: string;
  total_latency_ms: number | null;
  model_latency_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  error_code: string | null;
  tool_calls: ToolCall[] | null;
};
type Lead = { id: string; status: string; urgency: string | null; customer_id: string | null };
type Customer = { id: string; name: string; phone: string | null; email: string | null };
type Location = { id: string; address: string };
type Appointment = { id: string; kind: string; starts_at: string; status: string };
type WorkOrder = { id: string; type: string | null; status: string; scheduled_at: string | null };
type Notification = {
  id: string;
  audience: string;
  template: string;
  status: string;
  created_at: string;
};

// "delivered", "sent", ...; the Twilio error code follows a failure: "undelivered (30007)".
function deliveryLabel(status: string, errorCode: string | null): string {
  const failed = status === "undelivered" || status === "failed";
  return failed && errorCode ? `${status} (${errorCode})` : status;
}

function seconds(ms: number | null): string {
  return ms === null || ms === undefined ? "—" : `${(ms / 1000).toFixed(1)} s`;
}

// Tool results are stored as JSON text (possibly cut short); inputs as JSON.
function pretty(value: unknown): string {
  if (typeof value === "string") {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  return JSON.stringify(value, null, 2) ?? "";
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-neutral-200 bg-white p-4 shadow-sm">
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">
        {title}
      </h2>
      {children}
    </section>
  );
}

function None() {
  return <p className="text-sm text-neutral-500">None</p>;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2 text-sm">
      <dt className="w-20 shrink-0 text-neutral-500">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

function RunTrace({ run }: { run: Run }) {
  const calls = run.tool_calls ?? [];
  return (
    <div className="mt-1 max-w-[85%] space-y-1.5 rounded-lg border border-neutral-200 bg-white p-2 font-mono text-xs text-neutral-700">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Badge tone={outcomeTone(run.outcome)}>{run.outcome}</Badge>
        <span>total {seconds(run.total_latency_ms)}</span>
        <span>model {seconds(run.model_latency_ms)}</span>
        <span>
          tokens in {run.input_tokens ?? "—"} / out {run.output_tokens ?? "—"}
        </span>
        {run.error_code && <span className="text-red-700">error: {run.error_code}</span>}
      </div>
      {calls.map((call, i) => (
        <details key={i} className="rounded border border-neutral-200 bg-neutral-50">
          <summary className="flex cursor-pointer flex-wrap items-center gap-2 px-2 py-1">
            <span className="font-semibold">{call.name}</span>
            <span className={call.ok ? "text-green-700" : "text-red-700"}>
              {call.ok ? "✓" : "✗"}
            </span>
            <span className="text-neutral-500">{call.ms} ms</span>
            {call.wrote && (
              <span className="rounded bg-amber-100 px-1.5 text-amber-800">wrote</span>
            )}
          </summary>
          <div className="space-y-2 border-t border-neutral-200 px-2 py-2">
            <div>
              <div className="text-[10px] uppercase tracking-wide text-neutral-500">input</div>
              <pre className="whitespace-pre-wrap break-words">{pretty(call.input)}</pre>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wide text-neutral-500">result</div>
              <pre className="whitespace-pre-wrap break-words">{pretty(call.result)}</pre>
            </div>
          </div>
        </details>
      ))}
    </div>
  );
}

export default async function ConversationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
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

  // Runs as the logged-in user: another business's conversation looks exactly
  // like one that does not exist. A malformed id (22P02) is also a 404.
  const { data: conversationData, error: conversationError } = await supabase
    .from("conversations")
    .select("id, customer_number, status, created_at, updated_at, lead_id")
    .eq("id", id)
    .maybeSingle();
  if (conversationError?.code === "22P02" || (!conversationError && !conversationData)) {
    notFound();
  }
  if (conversationError || !conversationData) {
    return (
      <main className="min-h-screen bg-neutral-50 text-neutral-900">
        <div className="mx-auto max-w-3xl px-4 py-10">
          <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
            Could not load this conversation: {conversationError?.message}
          </p>
        </div>
      </main>
    );
  }
  const conversation = conversationData as Conversation;

  const [messageRes, runRes, leadRes, appointmentRes, workOrderRes, notificationRes] =
    await Promise.all([
      supabase
        .from("messages")
        .select(
          "id, direction, body, created_at, delivery_status, delivery_error_code, delivery_updated_at",
        )
        .eq("conversation_id", conversation.id)
        .order("created_at", { ascending: true }),
      supabase
        .from("agent_runs")
        .select(
          "id, inbound_message_id, outcome, total_latency_ms, model_latency_ms, input_tokens, output_tokens, error_code, tool_calls",
        )
        .eq("conversation_id", conversation.id),
      supabase
        .from("leads")
        .select("id, status, urgency, customer_id")
        .eq("id", conversation.lead_id)
        .maybeSingle(),
      supabase
        .from("appointments")
        .select("id, kind, starts_at, status")
        .eq("lead_id", conversation.lead_id)
        .order("starts_at", { ascending: true }),
      supabase
        .from("work_orders")
        .select("id, type, status, scheduled_at")
        .eq("lead_id", conversation.lead_id)
        .order("created_at", { ascending: true }),
      supabase
        .from("notifications")
        .select("id, audience, template, status, created_at")
        .or(`conversation_id.eq.${conversation.id},lead_id.eq.${conversation.lead_id}`)
        .order("created_at", { ascending: true }),
    ]);

  const lead = (leadRes.data ?? null) as Lead | null;
  const [customerRes, locationRes] = lead?.customer_id
    ? await Promise.all([
        supabase
          .from("customers")
          .select("id, name, phone, email")
          .eq("id", lead.customer_id)
          .maybeSingle(),
        supabase
          .from("service_locations")
          .select("id, address")
          .eq("customer_id", lead.customer_id)
          .order("created_at", { ascending: false }),
      ])
    : [null, null];

  const messages = (messageRes.data ?? []) as Message[];
  const runs = (runRes.data ?? []) as Run[];
  const appointments = (appointmentRes.data ?? []) as Appointment[];
  const workOrders = (workOrderRes.data ?? []) as WorkOrder[];
  const notifications = (notificationRes.data ?? []) as Notification[];
  const customer = (customerRes?.data ?? null) as Customer | null;
  const locations = (locationRes?.data ?? []) as Location[];
  const runByInbound = new Map(runs.map((r) => [r.inbound_message_id, r]));

  const loadError = [
    messageRes,
    runRes,
    leadRes,
    appointmentRes,
    workOrderRes,
    notificationRes,
    customerRes,
    locationRes,
  ].find((res) => res?.error)?.error;

  return (
    <main className="min-h-screen bg-neutral-50 text-neutral-900">
      <div className="mx-auto max-w-6xl px-4 py-6">
        <header className="mb-6 space-y-3">
          <Link href="/conversations" className="text-sm text-sky-700 underline">
            ← All conversations
          </Link>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="font-mono text-2xl font-semibold">
                {maskPhone(conversation.customer_number)}
              </h1>
              <Badge tone={statusTone(conversation.status)}>{conversation.status}</Badge>
              <span className="text-xs text-neutral-500">
                started {formatCentral(conversation.created_at, "datetime")}
              </span>
            </div>
            <AutoRefresh />
          </div>
        </header>

        {loadError && (
          <p className="mb-4 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
            Could not load everything: {loadError.message}
          </p>
        )}

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <div className="space-y-4 lg:col-span-2">
            {messages.length === 0 && <None />}
            {messages.map((m) => {
              const inbound = m.direction === "inbound";
              const body = m.body ?? "";
              const isOptIn = !inbound && body.startsWith(OPT_IN_PREFIX);
              const run = inbound ? runByInbound.get(m.id) : undefined;
              return (
                <div key={m.id} className={inbound ? "flex flex-col items-start" : "flex flex-col items-end"}>
                  <div
                    className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm ${
                      inbound ? "rounded-bl-sm bg-neutral-200" : "rounded-br-sm bg-sky-100"
                    }`}
                  >
                    <p className="whitespace-pre-wrap break-words">{body}</p>
                    <p className="mt-1 text-[11px] text-neutral-500">
                      {formatCentral(m.created_at, "time")}
                      {isOptIn && " · opt-in confirmation · system"}
                      {!inbound && m.delivery_status && (
                        <>
                          {" · "}
                          <Badge tone={deliveryTone(m.delivery_status)}>
                            {deliveryLabel(m.delivery_status, m.delivery_error_code)}
                          </Badge>
                        </>
                      )}
                    </p>
                  </div>
                  {run && <RunTrace run={run} />}
                </div>
              );
            })}
          </div>

          <aside className="space-y-4">
            <Section title="Customer">
              {customer ? (
                <dl className="space-y-1">
                  <Row label="Name">{customer.name}</Row>
                  <Row label="Phone">{maskPhone(customer.phone)}</Row>
                  <Row label="Email">{customer.email ?? "—"}</Row>
                  <Row label="Address">
                    {locations.length === 0
                      ? "—"
                      : locations.map((l) => <span key={l.id} className="block">{l.address}</span>)}
                  </Row>
                </dl>
              ) : (
                <None />
              )}
            </Section>

            <Section title="Lead">
              {lead ? (
                <dl className="space-y-1">
                  <Row label="Status">
                    <Badge tone={statusTone(lead.status)}>{lead.status}</Badge>
                  </Row>
                  <Row label="Urgency">{lead.urgency ?? "—"}</Row>
                </dl>
              ) : (
                <None />
              )}
            </Section>

            <Section title="Appointments">
              {appointments.length === 0 ? (
                <None />
              ) : (
                <ul className="space-y-1.5 text-sm">
                  {appointments.map((a) => (
                    <li key={a.id}>
                      <span className="font-medium">{KIND_LABEL[a.kind] ?? a.kind}</span> ·{" "}
                      {formatCentral(a.starts_at, "datetime")} ·{" "}
                      <Badge tone={statusTone(a.status)}>{a.status}</Badge>
                    </li>
                  ))}
                </ul>
              )}
            </Section>

            <Section title="Work orders">
              {workOrders.length === 0 ? (
                <None />
              ) : (
                <ul className="space-y-1.5 text-sm">
                  {workOrders.map((w) => (
                    <li key={w.id}>
                      <span className="font-medium">{w.type ?? "work order"}</span> · {w.status}
                      {w.scheduled_at && <> · {formatCentral(w.scheduled_at, "datetime")}</>}
                    </li>
                  ))}
                </ul>
              )}
            </Section>

            <Section title="Emails">
              {notifications.length === 0 ? (
                <None />
              ) : (
                <ul className="space-y-1.5 text-sm">
                  {notifications.map((n) => (
                    <li key={n.id}>
                      <span className="font-medium">{n.audience}</span> ·{" "}
                      <span className="font-mono text-xs">{n.template}</span> ·{" "}
                      <Badge tone={n.status === "failed" ? "red" : n.status === "sent" ? "green" : "gray"}>
                        {n.status}
                      </Badge>{" "}
                      · {formatCentral(n.created_at, "datetime")}
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          </aside>
        </div>
      </div>
    </main>
  );
}
