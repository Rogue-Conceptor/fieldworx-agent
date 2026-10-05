import "server-only";
import { CALL_TIMES, VISIT_WINDOWS } from "./config";

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

export type SlotKind = "service_visit" | "estimate_visit" | "phone_call";
export type Slot = {
  kind: SlotKind;
  start: string; // ISO UTC
  end: string; // ISO UTC
  label: string; // e.g. "Mon Oct 5, 9-11 AM"
};

// The wall-clock time Chicago shows at `instant`, expressed as if it were UTC
// (milliseconds). hourCycle h23 keeps midnight as 00, never 24.
function chicagoWallClockAsUtcMs(instant: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hourCycle: "h23",
  }).formatToParts(new Date(instant));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
}

// The UTC instant at which Chicago's wall clock reads the given date and time
// (month is 1-12). Guess the instant as if Chicago were UTC, measure how far
// off Chicago's clock is at that guess, shift by the difference, then re-check
// once: the second pass fixes guesses that land on the far side of a
// daylight-saving change.
export function centralToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): Date {
  const wanted = Date.UTC(year, month - 1, day, hour, minute);
  let instant = wanted;
  let offset = chicagoWallClockAsUtcMs(instant) - instant;
  instant = wanted - offset;
  const recheck = chicagoWallClockAsUtcMs(instant) - instant;
  if (recheck !== offset) {
    offset = recheck;
    instant = wanted - offset;
  }
  return new Date(instant);
}

// Bookable slots for the next `days` business days (Mon-Fri) in
// America/Chicago, starting TOMORROW. Visit kinds use VISIT_WINDOWS; phone
// calls use CALL_TIMES.
export function buildSlots(
  kind: SlotKind,
  now: Date = new Date(),
  days = 3,
): Slot[] {
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

  const slots: Slot[] = [];
  let found = 0;
  while (found < days) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    const weekday = cursor.getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    found++;
    const year = cursor.getUTCFullYear();
    const month = cursor.getUTCMonth() + 1;
    const day = cursor.getUTCDate();
    const dayLabel = `${DAY_NAMES[weekday]} ${MONTH_NAMES[month - 1]} ${day}`;

    if (kind === "phone_call") {
      for (const t of CALL_TIMES) {
        const start = centralToUtc(year, month, day, t.hour, t.minute);
        const end = new Date(start.getTime() + t.durationMin * 60_000);
        slots.push({
          kind,
          start: start.toISOString(),
          end: end.toISOString(),
          label: `${dayLabel}, ${t.label}`,
        });
      }
    } else {
      for (const w of VISIT_WINDOWS) {
        slots.push({
          kind,
          start: centralToUtc(year, month, day, w.startHour, 0).toISOString(),
          end: centralToUtc(year, month, day, w.endHour, 0).toISOString(),
          label: `${dayLabel}, ${w.label}`,
        });
      }
    }
  }
  return slots;
}

// Drops slots whose start instant is already booked. Compared as epoch
// milliseconds so "…T14:00:00Z" and "…T14:00:00.000Z" are the same instant.
export function openSlots(slots: Slot[], bookedStartsIso: string[]): Slot[] {
  const booked = new Set(bookedStartsIso.map((iso) => new Date(iso).getTime()));
  return slots.filter((slot) => !booked.has(new Date(slot.start).getTime()));
}

// "Mon Oct 5, 9-11 AM" for a stored appointment start: the same label
// buildSlots gave it when it was offered. A start that matches no configured
// window falls back to a plain clock time.
export function slotLabel(kind: SlotKind, startIso: string): string {
  // UTC fields of this Date are Chicago's wall-clock fields for the instant.
  const wall = new Date(chicagoWallClockAsUtcMs(new Date(startIso).getTime()));
  const hour = wall.getUTCHours();
  const minute = wall.getUTCMinutes();
  const dayLabel = `${DAY_NAMES[wall.getUTCDay()]} ${MONTH_NAMES[wall.getUTCMonth()]} ${wall.getUTCDate()}`;
  const configured =
    kind === "phone_call"
      ? CALL_TIMES.find((t) => t.hour === hour && t.minute === minute)?.label
      : VISIT_WINDOWS.find((w) => w.startHour === hour && minute === 0)?.label;
  const time =
    configured ??
    `${hour % 12 || 12}:${String(minute).padStart(2, "0")} ${hour < 12 ? "AM" : "PM"}`;
  return `${dayLabel}, ${time}`;
}
