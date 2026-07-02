import Link from "next/link";
import { CheckCircle2, MousePointerClick, ShieldCheck, Trophy, UserRoundCheck } from "lucide-react";
import { SetupNotice } from "@/components/SetupNotice";

export default function HomePage() {
  return (
    <main className="shell landing-shell">
      <div className="landing-container">
        <header className="landing-topbar">
          <div>
            <p className="eyebrow">ScoreCheck</p>
            <h1>Help me keep score with community driven score keeping!</h1>
          </div>
          <Link className="button admin-link" href="/admin/avp-denver">Open Admin</Link>
        </header>
        <SetupNotice />

        <section className="landing-hero">
          <div className="landing-copy">
            <h2>Score one court from your phone or computer.</h2>
            <p>
              Choose the match you are watching, enter your name, then use the scoring controls to add points and correct mistakes as the match happens.
              <span className="landing-score-impact">Your updates feed the live scoreboard.</span>
            </p>
          </div>

          <Link className="button primary landing-cta" href="/score">
            <CheckCircle2 size={22} /> Help score a court
          </Link>

          <div className="landing-steps" aria-label="How fan scoring works">
            <div>
              <ShieldCheck size={22} />
              <strong>1. Pick a court</strong>
              <span>Choose the court that matches the stream or court you are watching.</span>
            </div>
            <div>
              <UserRoundCheck size={22} />
              <strong>2. Enter your name</strong>
              <span>This lets the broadcast team know who is helping with that court.</span>
            </div>
            <div>
              <MousePointerClick size={22} />
              <strong>3. Update the score</strong>
              <span>Use the large + and - controls. Undo or edit the score if a point is entered wrong.</span>
            </div>
            <div>
              <Trophy size={22} />
              <strong>4. Start the next set</strong>
              <span>When a set is won, start the next set and keep scoring until the match ends.</span>
            </div>
          </div>
        </section>

        <footer className="legal-footer">
          <Link href="/privacy">Privacy Policy</Link>
          <Link href="/terms">Terms of Service</Link>
        </footer>
      </div>
    </main>
  );
}
