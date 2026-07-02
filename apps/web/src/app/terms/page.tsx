import Link from "next/link";

export const metadata = {
  title: "Terms of Service | ScoreCheck",
  description: "Terms of Service for ScoreCheck by Beach Volleyball Media."
};

export default function TermsPage() {
  return (
    <main className="shell legal-shell">
      <article className="legal-document">
        <p className="eyebrow">ScoreCheck</p>
        <h1>Terms of Service</h1>
        <p className="muted">Last updated: July 2, 2026</p>

        <section>
          <h2>Overview</h2>
          <p>
            ScoreCheck is a live event scoring tool operated by Beach Volleyball Media. By using ScoreCheck,
            you agree to these terms and to use the service only for legitimate live scoring and event operations.
          </p>
        </section>

        <section>
          <h2>Permitted Use</h2>
          <p>You may use ScoreCheck to:</p>
          <ul>
            <li>Verify as a scorekeeper for a live event broadcast.</li>
            <li>Submit score updates, corrections, and team-name suggestions for matches you are watching.</li>
            <li>View preview video when enabled for an active scoring session.</li>
          </ul>
        </section>

        <section>
          <h2>Scorekeeper Responsibilities</h2>
          <p>
            Scorekeepers should pay attention, enter scores accurately, and correct mistakes promptly. Do not
            intentionally submit false scores, impersonate another person, interfere with another scorekeeper, or
            use ScoreCheck to disrupt a broadcast or event.
          </p>
        </section>

        <section>
          <h2>Prohibited Conduct</h2>
          <p>You agree not to:</p>
          <ul>
            <li>Attempt to bypass verification or gain unauthorized access to admin or scoring sessions.</li>
            <li>Submit abusive, misleading, unlawful, or privacy-invasive content.</li>
            <li>Scrape, overload, reverse engineer, or attack ScoreCheck or connected services.</li>
            <li>Use ScoreCheck in a way that violates YouTube, event, venue, or applicable third-party rules.</li>
          </ul>
        </section>

        <section>
          <h2>YouTube and Third-Party Services</h2>
          <p>
            ScoreCheck uses YouTube API Services to verify scorekeepers through live chat messages on Beach
            Volleyball Media broadcasts. Your use of YouTube is governed by the{" "}
            <a href="https://www.youtube.com/t/terms">YouTube Terms of Service</a> and{" "}
            <a href="https://policies.google.com/privacy">Google Privacy Policy</a>.
          </p>
          <p>
            ScoreCheck may also rely on hosting, database, video streaming, and event-data providers. Those
            services may have their own terms and policies.
          </p>
        </section>

        <section>
          <h2>Availability and Accuracy</h2>
          <p>
            ScoreCheck is provided for live event operations and may be unavailable, delayed, or inaccurate due
            to network, data-source, video, or human-entry issues. Beach Volleyball Media may review, correct,
            override, suspend, or remove score updates when needed.
          </p>
        </section>

        <section>
          <h2>No Warranty</h2>
          <p>
            ScoreCheck is provided &quot;as is&quot; and &quot;as available&quot; without warranties of any kind. To the fullest
            extent permitted by law, Beach Volleyball Media disclaims implied warranties including merchantability,
            fitness for a particular purpose, and non-infringement.
          </p>
        </section>

        <section>
          <h2>Limitation of Liability</h2>
          <p>
            To the fullest extent permitted by law, Beach Volleyball Media will not be liable for indirect,
            incidental, consequential, special, exemplary, or punitive damages, or for loss of data, revenue,
            goodwill, or event opportunity arising from use of ScoreCheck.
          </p>
        </section>

        <section>
          <h2>Changes</h2>
          <p>
            We may update these terms as ScoreCheck changes. Continued use of ScoreCheck after updates means
            you accept the updated terms.
          </p>
        </section>

        <section>
          <h2>Contact</h2>
          <p>
            Questions about these terms can be sent to{" "}
            <a href="mailto:nathanhicks25@gmail.com">nathanhicks25@gmail.com</a>.
          </p>
        </section>

        <div className="legal-actions">
          <Link className="button" href="/">Back to ScoreCheck</Link>
          <Link className="button" href="/privacy">Privacy Policy</Link>
        </div>
      </article>
    </main>
  );
}
