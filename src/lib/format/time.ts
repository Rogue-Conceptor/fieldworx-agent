const TIME_ZONE = "America/Chicago";

// 12-hour Central time: "Oct 4, 7:37 PM" ("datetime") or "7:37 PM" ("time").
// Assembled from parts so the output never depends on the ICU build's
// separator characters (newer ICU puts a narrow no-break space before AM/PM).
export function formatCentral(iso: string, style: "datetime" | "time"): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    ...(style === "datetime" ? { month: "short", day: "numeric" } : {}),
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(date);
  const p: Record<string, string> = {};
  for (const part of parts) p[part.type] = part.value;

  const clock = `${p.hour}:${p.minute} ${p.dayPeriod}`;
  return style === "datetime" ? `${p.month} ${p.day}, ${clock}` : clock;
}
