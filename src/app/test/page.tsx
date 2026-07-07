import { createClient } from "@/lib/supabase/server";

export default async function TestPage() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return (
      <div style={{ maxWidth: 480, margin: "40px auto", fontFamily: "sans-serif" }}>
        <p>Not logged in — go to /login</p>
      </div>
    );
  }

  const { data: customers, error } = await supabase
    .from("customers")
    .select("id, name, phone");

  return (
    <div style={{ maxWidth: 480, margin: "40px auto", fontFamily: "sans-serif" }}>
      <h1>Customers (test)</h1>

      <p>Logged in as: {user.email}</p>

      {error && <p style={{ color: "red" }}>Error: {error.message}</p>}

      <p>Rows returned: {customers?.length ?? 0}</p>

      <ul>
        {customers?.map((c) => (
          <li key={c.id}>
            {c.name} — {c.phone ?? "(no phone)"}
          </li>
        ))}
      </ul>
    </div>
  );
}
