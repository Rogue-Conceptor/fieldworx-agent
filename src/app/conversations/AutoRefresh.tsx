"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { formatCentral } from "@/lib/format/time";

const REFRESH_MS = 3000;

// Re-runs the server component every few seconds so a live conversation
// updates on screen. Skips ticks while the tab is hidden.
export default function AutoRefresh() {
  const router = useRouter();
  // Empty until mounted: the server and first client render must match.
  const [lastUpdate, setLastUpdate] = useState("");

  useEffect(() => {
    const stamp = () => setLastUpdate(formatCentral(new Date().toISOString(), "time"));
    stamp();
    const id = setInterval(() => {
      if (document.hidden) return;
      router.refresh();
      stamp();
    }, REFRESH_MS);
    return () => clearInterval(id);
  }, [router]);

  return (
    <p className="text-xs text-neutral-500">
      <span className="text-green-600">●</span> Live — refreshing every 3 s · last
      update {lastUpdate || "—"}
    </p>
  );
}
