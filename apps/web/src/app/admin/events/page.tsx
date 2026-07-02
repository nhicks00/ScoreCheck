import Link from "next/link";
import { redirect } from "next/navigation";
import { isAdminRequest } from "@/lib/auth";
import { getEnv, missingEnvKeys } from "@/lib/env";
import { supabaseAdmin } from "@/lib/supabase";
import { SetupNotice } from "@/components/SetupNotice";

export const dynamic = "force-dynamic";

export default async function EventsPage() {
  if (!(await isAdminRequest())) redirect("/admin/login");
  const missing = missingEnvKeys();
  const env = getEnv();
  const events = missing.length
    ? []
    : (await supabaseAdmin().from("events").select("*").order("created_at", { ascending: false })).data ?? [];
  const siteUrl = env.publicSiteUrl.replace(/\/$/, "");

  return (
    <main className="shell">
      <div className="container stack">
        <div className="topbar">
          <h1 className="brand">Events</h1>
          <Link className="button" href="/">Home</Link>
        </div>
        <SetupNotice />
        <section className="grid two">
          <form className="panel stack" action="/api/events" method="post">
            <h2>Create Event</h2>
            <label>Name<input name="name" required placeholder="BVM June Showcase" /></label>
            <label>Date<input name="eventDate" type="date" /></label>
            <label>Venue<input name="venue" placeholder="Beach venue" /></label>
            <button className="primary" type="submit" disabled={missing.length > 0}>Create</button>
          </form>
          <div className="panel stack">
            <h2>Existing Events</h2>
            {events.length === 0 ? <p className="muted">No events yet.</p> : events.map((event) => (
              <div className="link-card" key={event.id}>
                <Link className="button" href={`/admin/events/${event.id}`}>
                  {event.name} {event.status === "active" ? "(active)" : ""}
                </Link>
                {event.status !== "active" && (
                  <form action={`/api/events/${event.id}/activate`} method="post">
                    <button type="submit">Activate</button>
                  </form>
                )}
              </div>
            ))}
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
