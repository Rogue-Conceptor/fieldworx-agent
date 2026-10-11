// Badge colors live here, under src/app, because Tailwind only generates
// classes it finds in files matched by tailwind.config.ts "content".
export type Tone = "green" | "orange" | "red" | "gray" | "blue";

const TONE_CLASS: Record<Tone, string> = {
  green: "bg-green-100 text-green-800",
  orange: "bg-orange-100 text-orange-800",
  red: "bg-red-100 text-red-800",
  gray: "bg-neutral-200 text-neutral-700",
  blue: "bg-sky-100 text-sky-800",
};

// agent_runs.outcome
export function outcomeTone(outcome: string): Tone {
  switch (outcome) {
    case "replied":
      return "green";
    case "safety":
      return "orange";
    case "skipped_opted_out":
      return "blue";
    case "fallback":
    case "error":
    case "send_failed":
      return "red";
    default: // skipped_keyword, superseded
      return "gray";
  }
}

// conversation, lead, and appointment statuses
export function statusTone(status: string | null | undefined): Tone {
  switch (status) {
    case "booked":
    case "active":
    case "scheduled":
      return "green";
    case "escalated":
      return "red";
    case "new":
      return "blue";
    default:
      return "gray";
  }
}

export default function Badge({
  tone,
  children,
}: {
  tone: Tone;
  children: React.ReactNode;
}) {
  return (
    <span
      className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${TONE_CLASS[tone]}`}
    >
      {children}
    </span>
  );
}
