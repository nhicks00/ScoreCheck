import Link from "next/link";
import { redirect } from "next/navigation";
import { isAdminRequest } from "@/lib/auth";
import { getEnv, missingEnvKeys } from "@/lib/env";
import { getActiveEvent, type EventRow } from "@/lib/eventConfig";
import { supabaseAdmin } from "@/lib/supabase";
import { SetupNotice } from "@/components/SetupNotice";

export const dynamic = "force-dynamic";

function formatEventDate(date?: string | null): string {
  if (!date) return "No date set";
  const parsed = new Date(`${date}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return date;
  return parsed.toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" });
}

function eventMeta(event: EventRow): string {
  const slug = event.slug ? `/${event.slug}` : "no slug";
  return `${slug} · ${formatEventDate(event.event_date)}`;
}

export default async function EventsPage() {
  if (!(await isAdminRequest())) redirect("/admin/login");
  const missing = missingEnvKeys();
  const env = getEnv();
  const db = missing.length ? null : supabaseAdmin();
  const events = db ? ((await db.from("events").select("*").order("created_at", { ascending: false })).data as EventRow[] | null) ?? [] : [];
  const activeEvent = db ? await getActiveEvent(db) : null;
  const activeId = activeEvent?.id ?? null;
  const siteUrl = env.publicSiteUrl.replace(/\/$/, "");

  const others = events.filter((event) => event.id !== activeId);
  const scheduled = others.filter((event) => (event.status ?? "").toLowerCase() !== "completed");
  const archived = others.filter((event) => (event.status ?? "").toLowerCase() === "completed");

  return (
    <main className="shell">
      <div className="container stack">
        <div className="topbar">
          <span className="brand-mark">Score<em>Check</em></span>
          <nav className="topbar-nav" aria-label="Admin">
            <Link className="button ghost" href="/admin/production">Production</Link>
            <Link className="button ghost" href="/admin/commentary">Commentary</Link>
            <Link className="button ghost" href="/">Home</Link>
          </nav>
        </div>
        <header className="admin-dashboard-header">
          <div>
            <h1>Events</h1>
            <p className="muted">One active event drives every public surface. Set the current tournament here — completed events move to Archived and never show publicly.</p>
          </div>
        </header>
        <SetupNotice />

        <section className="panel stack">
          <p className="eyebrow">Active event</p>
          {activeEvent ? (
            <div className="link-card">
              <div className="score-line" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
                <div className="stack" style={{ gap: 4 }}>
                  <strong style={{ fontSize: 18 }}>{activeEvent.name}</strong>
                  <span className="muted">{eventMeta(activeEvent)}</span>
                </div>
                <span className="status active">Active</span>
              </div>
              <div className="score-line" style={{ flexWrap: "wrap" }}>
                <Link className="button" href={`/admin/events/${activeEvent.id}`}>Open event</Link>
                <Link className="button ghost" href={`/admin/events/${activeEvent.id}/fan-scoring`}>Fan scoring</Link>
              </div>
            </div>
          ) : (
            <p className="muted">No active event yet. Create one below, or activate an existing event so the portals have a tournament to show.</p>
          )}
        </section>

        <section className="grid two">
          <div className="panel stack">
            <h2>Scheduled &amp; other events</h2>
            <p className="muted">Pick which tournament is current. Setting one active clears the others automatically.</p>
            {scheduled.length === 0 ? (
              <p className="muted">No other scheduled events.</p>
            ) : scheduled.map((event) => (
              <div className="link-card" key={event.id}>
                <div className="score-line" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
                  <Link className="button ghost" href={`/admin/events/${event.id}`}>{event.name}</Link>
                  <span className="muted">{eventMeta(event)}</span>
                </div>
                <div className="score-line" style={{ flexWrap: "wrap" }}>
                  <form action={`/api/events/${event.id}/activate`} method="post">
                    <button className="primary" type="submit">Set as active</button>
                  </form>
                  <form action={`/api/events/${event.id}/complete`} method="post">
                    <button type="submit">Mark completed</button>
                  </form>
                </div>
              </div>
            ))}
          </div>

          <form className="panel stack" action="/api/events" method="post">
            <h2>Create Event</h2>
            <label>Name<input name="name" required placeholder="BVM June Showcase" /></label>
            <label>Date<input name="eventDate" type="date" /></label>
            <label>Venue<input name="venue" placeholder="Beach venue" /></label>
            <button className="primary" type="submit" disabled={missing.length > 0}>Create</button>
          </form>

          <div className="panel stack span-all">
            <details>
              <summary><strong>Archived events</strong> <span className="muted">({archived.length})</span></summary>
              <p className="muted">Completed tournaments. These never appear on public portals. Reactivate only if a finished event needs to go live again.</p>
              {archived.length === 0 ? (
                <p className="muted">No archived events.</p>
              ) : archived.map((event) => (
                <div className="link-card" key={event.id}>
                  <div className="score-line" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
                    <Link className="button ghost" href={`/admin/events/${event.id}`}>{event.name}</Link>
                    <span className="muted">{eventMeta(event)}</span>
                  </div>
                  <div className="score-line" style={{ flexWrap: "wrap" }}>
                    <form action={`/api/events/${event.id}/activate`} method="post">
                      <button type="submit">Reactivate</button>
                    </form>
                  </div>
                </div>
              ))}
            </details>
          </div>

          <div className="panel stack span-all">
            <h2>Static Stream Overlay URLs</h2>
            <p className="muted">Paste these once into Streamrun or vMix. They always follow the active event.</p>
            <div className="grid two compact">
              {Array.from({ length: 8 }, (_, index) => {
                const streamNumber = index + 1;
                return (
                  <code key={streamNumber}>{siteUrl}/overlay/stream/{streamNumber}</code>
                );
              })}
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
