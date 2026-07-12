import { commentaryPortalEnabled, commentaryRoomName } from "@/lib/commentary";
import { isCommentaryRequest } from "@/lib/commentaryAuth";
import { getEnv } from "@/lib/env";
import { getActiveEvent } from "@/lib/eventConfig";
import { CommentaryDashboardClient } from "./CommentaryDashboardClient";

export const dynamic = "force-dynamic";

const errorMessages: Record<string, string> = {
  invalid: "That passcode is not right. Check with the producer and try again.",
  rate_limited: "Too many attempts. Wait a minute, then try again.",
  disabled: "The commentator portal is not enabled right now. Ask the producer to turn it on."
};

export default async function CommentaryPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const env = getEnv();

  if (!(await isCommentaryRequest())) {
    const { error } = await searchParams;
    const errorMessage = error ? errorMessages[error] ?? null : null;
    const portalDisabled = !commentaryPortalEnabled() || !env.adminSecret;
    return (
      <main className="shell">
        <div className="container auth-container stack">
          <span className="brand-mark">Score<em>Check</em></span>
          <section className="panel stack">
            <h1>Commentator Login</h1>
            <p className="muted">Enter the passcode from your producer to open the commentary portal.</p>
            {portalDisabled && (
              <p className="form-alert" role="alert">
                The commentator portal is not enabled right now. Ask the producer to set `COMMENTATOR_PASSCODE`.
              </p>
            )}
            {errorMessage && <p className="form-alert" role="alert">{errorMessage}</p>}
            <form className="stack" action="/api/commentary/login" method="post">
              <label>
                Passcode
                <input name="passcode" type="password" autoFocus required autoComplete="off" />
              </label>
              <button className="primary" type="submit">Enter portal</button>
            </form>
          </section>
        </div>
      </main>
    );
  }

  const rooms = Array.from({ length: env.courtCount }, (_, index) => {
    const streamNumber = index + 1;
    return {
      streamNumber,
      roomName: commentaryRoomName(streamNumber)
    };
  });

  // Event identity comes from the DB-resolved active event, never env.
  const active = env.supabaseUrl && env.supabaseServiceRoleKey ? await getActiveEvent() : null;
  return (
    <CommentaryDashboardClient
      eventSlug={active?.slug ?? ""}
      eventName={active?.name ?? "Live scoring"}
      rooms={rooms}
    />
  );
}
