import { redirect } from "next/navigation";
import { AdminTopbar } from "@/components/AdminTopbar";
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
        <AdminTopbar />
        <MonitorDashboardClient initial={initial} configured={configured} />
      </div>
    </main>
  );
}
