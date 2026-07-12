import Link from "next/link";
import { redirect } from "next/navigation";
import { isAdminRequest } from "@/lib/auth";
import { loadMonitorSnapshotWithFallback, monitorConfigured } from "@/lib/monitoring";
import { MonitorDashboardClient } from "./MonitorDashboardClient";

export const dynamic = "force-dynamic";

export default async function MonitorPage() {
  if (!(await isAdminRequest())) redirect(`/admin/login?next=${encodeURIComponent("/admin/monitor")}`);
  const configured = monitorConfigured();
  const initial = configured ? await loadMonitorSnapshotWithFallback().catch(() => null) : null;

  return (
    <main className="shell monitor-shell">
      <div className="container admin-container monitor-container">
        <div className="topbar monitor-topbar">
          <Link className="brand-mark" href="/admin/events">Score<em>Check</em></Link>
          <nav className="topbar-nav" aria-label="Admin">
            <Link className="button ghost" href="/admin/production">Production</Link>
            <Link className="button ghost" href="/admin/events">Events</Link>
            <Link className="button ghost" href="/admin/commentary">Commentary</Link>
          </nav>
        </div>
        <MonitorDashboardClient initial={initial} configured={configured} />
      </div>
    </main>
  );
}
