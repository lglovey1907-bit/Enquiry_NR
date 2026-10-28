import Link from "next/link";
import type { Profile } from "@/lib/auth";

export default function Header({ profile, active }: { profile: Profile | null; active?: "dashboard" | "admin" }) {
  return (
    <header className="band">
      <div className="band-in">
        <div className="brand">
          <small>Northern Railway · Delhi Division</small>
          <b>NR Enquiry Desk</b>
        </div>
        <nav className="nav" aria-label="Main">
          {profile && <span className="who">{profile.full_name} · {profile.hrms_id}</span>}
          <Link href="/" target="_blank" rel="noopener">Live board</Link>
          {profile?.status === "approved" && (
            <Link href="/dashboard" className={active === "dashboard" ? "active" : ""}>Trains</Link>
          )}
          {profile?.status === "approved" && profile.role === "admin" && (
            <Link href="/admin" className={active === "admin" ? "active" : ""}>Staff approvals</Link>
          )}
          <form action="/auth/signout" method="post" style={{ display: "contents" }}>
            <button type="submit">Sign out</button>
          </form>
        </nav>
      </div>
    </header>
  );
}
