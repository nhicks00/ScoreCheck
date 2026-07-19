import { redirect } from "next/navigation";
import { isAdminRequest } from "@/lib/auth";
import { AdminTopbar } from "@/components/AdminTopbar";
import { StreamPlayer } from "@/components/StreamPlayer";

export const dynamic = "force-dynamic";

export default async function AdminStreamPreviewPage({ params }: { params: Promise<{ courtNumber: string }> }) {
  const { courtNumber: courtParam } = await params;
  const courtNumber = Number(courtParam);
  const path = `/admin/stream-preview/${encodeURIComponent(courtParam)}`;
  if (!(await isAdminRequest())) redirect(`/admin/login?next=${encodeURIComponent(path)}`);
  if (!Number.isInteger(courtNumber) || courtNumber < 1 || courtNumber > 99) redirect("/admin/events");

  return (
    <main className="scorer-screen">
      <div className="scorer-wrap">
        <AdminTopbar />
        <section className="role-banner active">
          <div>
            <span>Admin video check</span>
            <h1>Court {courtNumber} private preview</h1>
            <p>Uses the admin cookie to fetch MediaMTX playback sources. WHEP first, HLS fallback.</p>
          </div>
          <strong>LIVE</strong>
        </section>
        <StreamPlayer courtNumber={courtNumber} />
      </div>
    </main>
  );
}
