import { getEnv } from "@/lib/env";

export default function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const env = getEnv();
  return (
    <main className="shell">
      <div className="container" style={{ maxWidth: 460 }}>
        <section className="panel stack">
          <h1>Admin Login</h1>
          {!env.adminSecret && (
            <p className="muted">Set `ADMIN_SECRET` in Vercel before deploying this admin surface publicly.</p>
          )}
          <form className="stack" action="/api/admin/login" method="post">
            <input type="hidden" name="next" value="/admin/events" />
            <label>
              Admin secret
              <input name="secret" type="password" autoFocus required />
            </label>
            <button className="primary" type="submit">Log in</button>
          </form>
        </section>
      </div>
    </main>
  );
}
