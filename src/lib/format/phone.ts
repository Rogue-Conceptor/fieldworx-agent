// Phone numbers are never shown in full: "***" plus the last 4 digits, or just
// "***" when there is nothing (or too little) to show.
export function maskPhone(n: string | null | undefined): string {
  if (!n || n.length < 4) return "***";
  return "***" + n.slice(-4);
}
