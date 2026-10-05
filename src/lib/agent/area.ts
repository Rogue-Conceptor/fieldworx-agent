import "server-only";

// The LAST standalone 5-digit number in the input, since a ZIP closes an
// address ("12345 Main St, Dallas 75043" -> "75043"). ZIP+4 is fine: the
// "-1234" tail is only 4 digits. Longer digit runs, like a 6-digit number,
// are not ZIPs.
export function normalizeZip(input: string): string | null {
  const runs = input.match(/\d+/g) ?? [];
  for (let i = runs.length - 1; i >= 0; i--) {
    if (runs[i].length === 5) return runs[i];
  }
  return null;
}

// True if the ZIP starts with any prefix. No prefixes (or only empty ones)
// means no service area is configured, so nothing is in it.
export function zipInArea(
  zip: string,
  prefixes: readonly string[] | null | undefined,
): boolean {
  return (prefixes ?? []).some((prefix) => prefix.length > 0 && zip.startsWith(prefix));
}

// Deliberately simple: one "@", a non-empty local part, a domain with a dot
// that has text on both sides, no whitespace, at most 254 characters.
export function isValidEmail(s: string): boolean {
  if (s.length === 0 || s.length > 254 || /\s/.test(s)) return false;
  const parts = s.split("@");
  if (parts.length !== 2) return false;
  const [local, domain] = parts;
  return local.length > 0 && /^[^.]+(\.[^.]+)+$/.test(domain);
}
