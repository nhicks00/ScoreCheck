import Link from "next/link";

export const metadata = {
  title: "Privacy Policy | ScoreCheck",
  description: "Privacy Policy for ScoreCheck by Beach Volleyball Media."
};

export default function PrivacyPage() {
  return (
    <main className="shell legal-shell">
      <article className="legal-document">
        <p className="eyebrow">ScoreCheck</p>
        <h1>Privacy Policy</h1>
        <p className="muted">Last updated: July 2, 2026</p>

        <section>
          <h2>Overview</h2>
          <p>
            ScoreCheck is operated by Beach Volleyball Media to support live volleyball event scoring.
            ScoreCheck lets scorekeepers verify themselves through live chat and submit score updates for
            matches being broadcast.
          </p>
        </section>

        <section>
          <h2>Information We Collect</h2>
          <p>We collect the information needed to operate live scoring, including:</p>
          <ul>
            <li>Scorekeeper display names entered in ScoreCheck.</li>
            <li>One-time verification codes typed into live chat.</li>
            <li>Live chat message metadata needed to verify a scorekeeper, such as message text, message ID, author channel ID, author display name, profile image URL, and message timestamp.</li>
            <li>Scoring actions, corrections, timestamps, court assignments, and session status.</li>
            <li>Basic technical data such as browser user agent, approximate request metadata, and hashed IP/device identifiers for security and abuse prevention.</li>
          </ul>
        </section>

        <section>
          <h2>How We Use Information</h2>
          <p>We use information to:</p>
          <ul>
            <li>Verify that a scorekeeper controls or is present in the live chat for a broadcast.</li>
            <li>Operate live scoring, score corrections, scoreboard overlays, and administrative review tools.</li>
            <li>Prevent abuse, duplicate claims, spam, or unauthorized scoring access.</li>
            <li>Diagnose technical issues and improve live event operations.</li>
          </ul>
        </section>

        <section>
          <h2>YouTube API Services</h2>
          <p>
            ScoreCheck uses YouTube API Services to read live chat messages from Beach Volleyball Media
            broadcasts for the limited purpose of detecting scorekeeper verification codes. ScoreCheck does
            not upload videos, delete videos, modify YouTube content, automate comments, or access live chat
            for unrelated purposes.
          </p>
          <p>
            Use of YouTube is also governed by the <a href="https://www.youtube.com/t/terms">YouTube Terms of Service</a>
            {" "}and the <a href="https://policies.google.com/privacy">Google Privacy Policy</a>.
          </p>
        </section>

        <section>
          <h2>Sharing</h2>
          <p>
            We do not sell personal information. We may share information with service providers that host or
            operate ScoreCheck, including hosting, database, video infrastructure, logging, and security providers.
            We may also disclose information when required by law or to protect the service, event participants,
            viewers, or our rights.
          </p>
        </section>

        <section>
          <h2>Retention</h2>
          <p>
            We retain scoring records, session logs, and verification records for event operations, auditing,
            troubleshooting, and abuse prevention. We delete or anonymize data when it is no longer reasonably
            needed for those purposes.
          </p>
        </section>

        <section>
          <h2>Your Choices</h2>
          <p>
            Do not enter sensitive personal information into ScoreCheck display name fields or live chat verification
            messages. To request access, correction, or deletion of ScoreCheck-related information, contact Beach
            Volleyball Media at <a href="mailto:nathanhicks25@gmail.com">nathanhicks25@gmail.com</a>.
          </p>
        </section>

        <section>
          <h2>Contact</h2>
          <p>
            Questions about this Privacy Policy can be sent to{" "}
            <a href="mailto:nathanhicks25@gmail.com">nathanhicks25@gmail.com</a>.
          </p>
        </section>

        <div className="legal-actions">
          <Link className="button" href="/">Back to ScoreCheck</Link>
          <Link className="button" href="/terms">Terms of Service</Link>
        </div>
      </article>
    </main>
  );
}
