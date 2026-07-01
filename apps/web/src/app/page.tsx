import Link from "next/link";
import { SetupNotice } from "@/components/SetupNotice";

export default function HomePage() {
  return (
    <main className="shell">
      <div className="container stack">
        <div className="topbar">
          <div className="brand">ScoreCheck</div>
          <div className="row wrap">
            <Link className="button primary" href="/score">Score a court</Link>
            <Link className="button" href="/admin/avp-denver">Open Admin</Link>
          </div>
        </div>
        <SetupNotice />
        <section className="panel">
          <h1>AVP Denver fan scoring</h1>
          <p className="muted">
            Parent-friendly scoring links, verified scorekeeper sessions, private scorer preview video, and read-only StreamRun overlays.
          </p>
        </section>
      </div>
    </main>
  );
}
