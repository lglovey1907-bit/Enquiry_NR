import { redirect } from "next/navigation";
import Header from "@/components/Header";
import { getSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function PendingPage() {
  const { user, profile } = await getSession();
  if (!user) redirect("/login");
  if (!profile) redirect("/register?step=details");
  if (profile.status === "approved") redirect("/staff");

  const text = {
    pending: { title: "Waiting for approval", body: "Your registration has reached the admin. You can sign in and enter trains once it is approved." },
    rejected: { title: "Registration not approved", body: "The admin did not approve this registration. Contact the Commercial Branch if you think this is a mistake." },
    disabled: { title: "Account disabled", body: "This account has been disabled by the admin. Contact the Commercial Branch to have it restored." },
  }[profile.status];

  return (
    <>
      <Header profile={profile} />
      <main className="wrap">
        <section className="panel">
          <div>
            <span className={`pill ${profile.status}`}>{profile.status}</span>
            <h1 style={{ marginTop: 8 }}>{text.title}</h1>
            <p className="lede">{text.body}</p>
          </div>
          <table>
            <tbody>
              <tr><th scope="row">Name</th><td>{profile.full_name}</td></tr>
              <tr><th scope="row">HRMS ID</th><td>{profile.hrms_id}</td></tr>
              <tr><th scope="row">Email</th><td>{profile.email}</td></tr>
            </tbody>
          </table>
        </section>
      </main>
    </>
  );
}
