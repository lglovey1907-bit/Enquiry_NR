"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

type Step = "email" | "code" | "details";

function Register() {
  const router = useRouter();
  const params = useSearchParams();
  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [hrms, setHrms] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");

  // Someone who verified their email earlier but never finished goes straight to their details.
  useEffect(() => {
    if (params.get("step") !== "details") return;
    createClient().auth.getUser().then(({ data }) => {
      if (data.user?.email) { setEmail(data.user.email); setStep("details"); }
    });
  }, [params]);

  async function sendCode(e?: React.FormEvent) {
    e?.preventDefault();
    setBusy(true); setError(""); setInfo("");
    const { error } = await createClient().auth.signInWithOtp({
      email: email.trim().toLowerCase(),
      options: { shouldCreateUser: true },
    });
    setBusy(false);
    if (error) {
      setError(error.status === 429
        ? "Too many codes requested. Wait a minute and try again."
        : error.message);
      return;
    }
    setInfo(`We sent a 6-digit code to ${email.trim().toLowerCase()}. It is valid for 10 minutes.`);
    setStep("code");
  }

  async function verifyCode(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError("");
    const supabase = createClient();
    const { data, error } = await supabase.auth.verifyOtp({
      email: email.trim().toLowerCase(), token: code.trim(), type: "email",
    });
    if (error || !data.user) {
      setBusy(false);
      setError("That code is wrong or has expired. Check the latest email or send a new code.");
      return;
    }
    // Already registered? Send them to their status page instead of re-registering.
    const { data: existing } = await supabase.from("profiles").select("id").eq("id", data.user.id).maybeSingle();
    setBusy(false); setInfo("");
    if (existing) { router.replace("/staff"); router.refresh(); return; }
    setStep("details");
  }

  async function saveDetails(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (password.length < 8) { setError("Password must be at least 8 characters."); return; }
    if (password !== confirm) { setError("The two passwords don't match."); return; }
    if (!/^[A-Za-z0-9]{4,20}$/.test(hrms.trim())) { setError("HRMS ID should be 4–20 letters or digits."); return; }
    setBusy(true);
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setBusy(false); setError("Your verification has expired. Start again with your email."); setStep("email"); return; }

    const { error: pwErr } = await supabase.auth.updateUser({ password });
    if (pwErr) { setBusy(false); setError(pwErr.message); return; }

    const { error: insErr } = await supabase.from("profiles").insert({
      id: user.id, email: user.email, full_name: name.trim(), hrms_id: hrms.trim().toUpperCase(),
    });
    setBusy(false);
    if (insErr) {
      setError(insErr.code === "23505" ? "This HRMS ID is already registered. Contact the admin if this is wrong." : insErr.message);
      return;
    }
    router.replace("/pending");
    router.refresh();
  }

  const stepIndex = { email: 0, code: 1, details: 2 }[step];

  return (
    <main className="auth">
      <div className="panel">
        <div className="steps" aria-hidden="true">
          {[0, 1, 2].map(i => <span key={i} className={i <= stepIndex ? "on" : ""} />)}
        </div>
        <div>
          <h1>Staff registration</h1>
          <p className="lede">
            {step === "email" && "Step 1 of 3 · Enter your email to receive a verification code."}
            {step === "code" && "Step 2 of 3 · Enter the code from your email."}
            {step === "details" && "Step 3 of 3 · Your particulars and a password of your choice."}
          </p>
        </div>

        {info && <div className="msg info">{info}</div>}

        {step === "email" && (
          <form onSubmit={sendCode}>
            <label htmlFor="email">Email
              <input id="email" type="email" autoComplete="email" required value={email} onChange={e => setEmail(e.target.value)} />
            </label>
            {error && <div className="msg err" role="alert">{error}</div>}
            <button className="btn" type="submit" disabled={busy}>{busy ? "Sending…" : "Send code"}</button>
          </form>
        )}

        {step === "code" && (
          <form onSubmit={verifyCode}>
            <label htmlFor="code">Verification code
              <input id="code" className="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6}
                required value={code} onChange={e => setCode(e.target.value.replace(/\D/g, ""))} />
            </label>
            {error && <div className="msg err" role="alert">{error}</div>}
            <button className="btn" type="submit" disabled={busy || code.length !== 6}>{busy ? "Checking…" : "Verify"}</button>
            <p className="lede">
              Didn't get it? Check spam, or <button type="button" className="linkbtn" onClick={() => sendCode()} disabled={busy}>send a new code</button>.{" "}
              <button type="button" className="linkbtn" onClick={() => { setStep("email"); setCode(""); setInfo(""); setError(""); }}>Change email</button>
            </p>
          </form>
        )}

        {step === "details" && (
          <form onSubmit={saveDetails}>
            <label htmlFor="em">Email
              <input id="em" type="email" value={email} disabled />
            </label>
            <label htmlFor="name">Full name
              <input id="name" autoComplete="name" required minLength={2} maxLength={100} value={name} onChange={e => setName(e.target.value)} />
            </label>
            <label htmlFor="hrms">HRMS ID
              <input id="hrms" required value={hrms} onChange={e => setHrms(e.target.value)} />
            </label>
            <label htmlFor="pw">Password <span className="hint">At least 8 characters</span>
              <input id="pw" type="password" autoComplete="new-password" required value={password} onChange={e => setPassword(e.target.value)} />
            </label>
            <label htmlFor="pw2">Confirm password
              <input id="pw2" type="password" autoComplete="new-password" required value={confirm} onChange={e => setConfirm(e.target.value)} />
            </label>
            {error && <div className="msg err" role="alert">{error}</div>}
            <button className="btn" type="submit" disabled={busy}>{busy ? "Saving…" : "Submit for approval"}</button>
          </form>
        )}

        <p className="lede">Already registered? <Link href="/login">Sign in</Link></p>
      </div>
    </main>
  );
}

export default function RegisterPage() {
  return <Suspense fallback={null}><Register /></Suspense>;
}
