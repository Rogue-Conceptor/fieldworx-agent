"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export default function LoginPage() {
  const router = useRouter();
  const supabase = createClient();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [currentEmail, setCurrentEmail] = useState<string | null>(null);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setCurrentEmail(data.user?.email ?? null);
    });
  }, [supabase]);

  async function handleLogin() {
    setError(null);
    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    if (error) {
      setError(error.message);
      return;
    }
    router.push("/test");
  }

  async function handleLogout() {
    setError(null);
    const { error } = await supabase.auth.signOut();
    if (error) {
      setError(error.message);
      return;
    }
    setCurrentEmail(null);
  }

  return (
    <div style={{ maxWidth: 320, margin: "40px auto", fontFamily: "sans-serif" }}>
      <h1>Login (test)</h1>

      <p>Current user: {currentEmail ?? "not logged in"}</p>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <input
          type="email"
          placeholder="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <input
          type="password"
          placeholder="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <button onClick={handleLogin}>Log in</button>
        <button onClick={handleLogout}>Log out</button>
      </div>

      {error && <p style={{ color: "red", marginTop: 12 }}>Error: {error}</p>}
    </div>
  );
}
