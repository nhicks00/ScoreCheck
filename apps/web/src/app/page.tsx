import Link from "next/link";
import { ArrowRight, MousePointerClick, ShieldCheck, Trophy, UserRoundCheck } from "lucide-react";
import { SetupNotice } from "@/components/SetupNotice";

export default function HomePage() {
  return (
    <main className="shell landing-shell">
      <div className="landing-container">
        <header className="landing-topbar">
          <span className="brand-mark">Score<em>Check</em></span>
          <nav className="landing-nav" aria-label="Site">
            <Link className="button ghost admin-link" href="/admin/avp-denver">Open Admin</Link>
            <Link className="button primary" href="/score">Score a court</Link>
          </nav>
        </header>

        <SetupNotice />

        <section className="landing-hero">
          <span className="hero-badge"><span className="live-dot" aria-hidden="true" /> Live fan scoring</span>
          <h1>
            Every court. Every point. <span className="hero-accent">Scored by fans.</span>
          </h1>
          <p className="hero-sub">
            Pick the beach volleyball court you are watching, tap the team that wins each point,
            and your score lands on the live broadcast scoreboard in seconds.
          </p>
          <div className="hero-actions">
            <Link className="button primary xl" href="/score">
              See live courts <ArrowRight size={20} />
            </Link>
            <a className="button xl" href="#how-it-works">How it works</a>
          </div>
          <div className="hero-scorebug" aria-hidden="true">
            <div className="bug-head">
              <span>Court 3 · Set 2</span>
              <span className="bug-live"><span className="live-dot" /> Live</span>
            </div>
            <div className="bug-row team-a">
              <span className="bug-bar" />
              <span className="bug-name">Hicks / Alvarez</span>
              <span className="bug-sets"><i className="won" /><i /></span>
              <span className="bug-score">18</span>
            </div>
            <div className="bug-row team-b">
              <span className="bug-bar" />
              <span className="bug-name">Kim / Delgado</span>
              <span className="bug-sets"><i /><i /></span>
              <span className="bug-score">16</span>
            </div>
          </div>
          <p className="hero-note">No account needed. Works on any phone, right from the beach.</p>
        </section>

        <section className="landing-steps" id="how-it-works" aria-label="How fan scoring works">
          <h2 className="section-title">
            How it works
            <small>Four quick steps from spectator to scorekeeper.</small>
          </h2>
          <div className="steps-grid">
            <div className="step-card">
              <span className="step-num">Step 1</span>
              <ShieldCheck size={22} />
              <strong>Pick a court</strong>
              <span>Choose the court that matches the stream or the sand in front of you.</span>
            </div>
            <div className="step-card">
              <span className="step-num">Step 2</span>
              <UserRoundCheck size={22} />
              <strong>Enter your name</strong>
              <span>The broadcast team sees who is helping keep score on each court.</span>
            </div>
            <div className="step-card">
              <span className="step-num">Step 3</span>
              <MousePointerClick size={22} />
              <strong>Update the score</strong>
              <span>Tap the big + and - controls. Undo or edit if a point goes in wrong.</span>
            </div>
            <div className="step-card">
              <span className="step-num">Step 4</span>
              <Trophy size={22} />
              <strong>Start the next set</strong>
              <span>When a set is won, roll straight into the next one until the match ends.</span>
            </div>
          </div>
          <Link className="button primary landing-cta" href="/score">
            Help score a court <ArrowRight size={20} />
          </Link>
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
