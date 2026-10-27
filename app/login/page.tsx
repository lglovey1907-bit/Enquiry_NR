"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim().toLowerCase(), password });
    if (error) {
      setError(error.message === "Invalid login credentials"
        ? "Email or password is incorrect."
        : error.message);
      setBusy(false);
      return;
    }
    router.replace("/");
    router.refresh();
  }

  return (
    <main className="auth">
      <div className="panel">
        <div>
          <h1>Staff sign in</h1>
          <p className="lede">NR Enquiry Desk · Delhi Division</p>
        </div>
        <form onSubmit={onSubmit}>
          <label htmlFor="email">Email
            <input id="email" type="email" autoComplete="email" required value={email} onChange={e => setEmail(e.target.value)} />
          </label>
          <label htmlFor="password">Password
            <input id="password" type="password" autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)} />
          </label>
          {error && <div className="msg err" role="alert">{error}</div>}
          <button className="btn" type="submit" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
        </form>
        <p className="lede">New staff member? <Link href="/register">Register with your email</Link></p>
      </div>
    </main>
  );
}
