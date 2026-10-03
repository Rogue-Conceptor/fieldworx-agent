import "server-only";

const TIME_ZONE = "America/Chicago";
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

// e.g. "Saturday, October 3, 2026, 3:45 PM Central". Assembled from parts so
// the output never depends on the ICU build's separator characters.
export function nowCentral(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(now);
  const p: Record<string, string> = {};
  for (const part of parts) p[part.type] = part.value;
  return `${p.weekday}, ${p.month} ${p.day}, ${p.year}, ${p.hour}:${p.minute} ${p.dayPeriod} Central`;
}

// The next `days` business days (Mon-Fri) in America/Chicago, starting
// TOMORROW, each paired with every window: "Mon Oct 5, 9-11 AM".
export function demoSlots(
  windows: string[],
  now: Date = new Date(),
  days = 3,
): string[] {
  // Today's calendar date in Chicago, carried as a UTC-midnight Date so the
  // day arithmetic and weekday lookups cannot be thrown off by DST.
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(now);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const cursor = new Date(Date.UTC(get("year"), get("month") - 1, get("day")));

  const slots: string[] = [];
  let found = 0;
  while (found < days) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    const weekday = cursor.getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    found++;
    const label = `${DAY_NAMES[weekday]} ${MONTH_NAMES[cursor.getUTCMonth()]} ${cursor.getUTCDate()}`;
    for (const window of windows) slots.push(`${label}, ${window}`);
  }
  return slots;
}
