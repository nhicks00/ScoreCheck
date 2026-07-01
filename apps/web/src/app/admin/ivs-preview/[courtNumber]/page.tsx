import Link from "next/link";
import { redirect } from "next/navigation";
import { isAdminRequest } from "@/lib/auth";
import { AdminIvsPreviewClient } from "./AdminIvsPreviewClient";

export const dynamic = "force-dynamic";

export default async function AdminIvsPreviewPage({ params }: { params: Promise<{ courtNumber: string }> }) {
  const { courtNumber: courtParam } = await params;
  const courtNumber = Number(courtParam);
  const path = `/admin/ivs-preview/${encodeURIComponent(courtParam)}`;
  if (!(await isAdminRequest())) redirect(`/admin/login?next=${encodeURIComponent(path)}`);
  if (!Number.isInteger(courtNumber) || courtNumber < 1 || courtNumber > 99) redirect("/admin/events");

  return (
    <main className="scorer-screen">
      <div className="scorer-wrap">
        <div className="topbar">
          <div className="brand">Court {courtNumber} IVS Preview</div>
          <Link className="button" href="/admin/events">Admin</Link>
        </div>
        <section className="role-banner active">
          <div>
            <span>Admin video check</span>
            <h1>Court {courtNumber} private preview</h1>
            <p>Uses the admin cookie to mint short-lived IVS playback tokens.</p>
          </div>
          <strong>IVS</strong>
        </section>
        <AdminIvsPreviewClient courtNumber={courtNumber} />
      </div>
    </main>
  );
}
