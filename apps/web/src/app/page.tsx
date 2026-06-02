import Link from "next/link";
import { SetupNotice } from "@/components/SetupNotice";

export default function HomePage() {
  return (
    <main className="shell">
      <div className="container stack">
        <div className="topbar">
          <div className="brand">MultiCourtScore Cloud</div>
          <Link className="button primary" href="/admin/events">Open Admin</Link>
        </div>
        <SetupNotice />
        <section className="panel">
          <h1>Cloud scoreboard overlays for Streamrun</h1>
          <p className="muted">
            Configure events, discover VolleyballLife matches, assign courts, and publish public HTTPS overlay URLs from Vercel.
          </p>
        </section>
      </div>
    </main>
  );
}
