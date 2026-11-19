import Link from "next/link";
import type { Profile } from "@/lib/auth";

/** `board`: the station whose public board "Live board" opens (default New Delhi at /).
 *  `stationsNav`: show the Stations link to a station admin who isn't the overall admin. */
export default function Header({ profile, active, board, stationsNav }: {
  profile: Profile | null; active?: "dashboard" | "admin" | "stations"; board?: string; stationsNav?: boolean;
}) {
  const isAdmin = profile?.status === "approved" && profile.role === "admin";
  return (
    <header className="band">
      <div className="band-in">
        <div className="brand">
          <small>Northern Railway · Delhi Division</small>
          <b>NR Enquiry Desk</b>
        </div>
        <nav className="nav" aria-label="Main">
          {profile && <span className="who">{profile.full_name} · {profile.hrms_id}</span>}
          <Link href={board ? `/${board}` : "/"} target="_blank" rel="noopener">{board ? `Live board · ${board}` : "Live board · NDLS"}</Link>
          {profile?.status === "approved" && (
            <Link href="/dashboard" className={active === "dashboard" ? "active" : ""}>NDLS trains</Link>
          )}
          {profile?.status === "approved" && profile.role === "admin" && (
            <Link href="/admin" className={active === "admin" ? "active" : ""}>Staff approvals</Link>
          )}
          {(isAdmin || (profile?.status === "approved" && stationsNav)) && (
            <Link href="/stations" className={active === "stations" ? "active" : ""}>Stations</Link>
          )}
          <form action="/auth/signout" method="post" style={{ display: "contents" }}>
            <button type="submit">Sign out</button>
          </form>
        </nav>
      </div>
    </header>
  );
}
