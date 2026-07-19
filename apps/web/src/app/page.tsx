import Link from "next/link";
import { SetupNotice } from "@/components/SetupNotice";

export default function HomePage() {
  return (
    <main className="shell landing-shell landing-reference-shell">
      <div className="landing-container landing-reference-container">
        <header className="landing-topbar landing-reference-topbar">
          <nav className="landing-nav" aria-label="Site navigation">
            <Link className="landing-admin-link" href="/admin/events">Open Admin</Link>
          </nav>
        </header>

        <SetupNotice />

        <section className="landing-hero landing-reference-hero">
          <div className="landing-reference-copy">
            <h1>
              Keep the<br />match in view.
            </h1>
            <p className="hero-sub">
              Pick a beach volleyball court, update the score in real time,<br className="desktop-copy-break" />
              and help everyone follow the match.
            </p>
            <div className="hero-actions">
              <Link className="button primary xl landing-reference-cta" href="/score">
                See live courts
              </Link>
            </div>
          </div>

          <div
            className="landing-court-score"
            aria-label="Court 3, set 2: Hicks and Alvarez 18, Kim and Delgado 16"
          >
            <span className="landing-court-meta">Court 3 <i aria-hidden="true">•</i> Set 2</span>
            <div className="landing-matchup">
              <span className="landing-team landing-team-left">Hicks / Alvarez</span>
              <strong className="landing-points landing-points-leading">18</strong>
              <span className="landing-score-divider" aria-hidden="true" />
              <strong className="landing-points">16</strong>
              <span className="landing-team landing-team-right">Kim / Delgado</span>
            </div>
          </div>
        </section>

        <section className="landing-reference-guide" aria-label="How fan scoring works">
          <div className="landing-guide-grid">
            <div className="landing-guide-item">
              <strong>Pick a court</strong>
              <span>Choose the match you&apos;re watching.</span>
            </div>
            <div className="landing-guide-item">
              <strong>Update the score</strong>
              <span>Tap the points as they happen.</span>
            </div>
            <div className="landing-guide-item">
              <strong>Help the broadcast</strong>
              <span>Your updates power the live scoreboard.</span>
            </div>
          </div>
        </section>

        <footer className="landing-footer">
          <span className="brand-mark small">Score<em>Check</em></span>
          <span>Fan-powered scoring for beach volleyball broadcasts.</span>
          <nav className="footer-links" aria-label="Legal">
            <Link href="/privacy">Privacy Policy</Link>
            <Link href="/terms">Terms of Service</Link>
          </nav>
        </footer>
      </div>
    </main>
  );
}
