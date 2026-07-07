import { getEnv } from "@/lib/env";

const errorMessages: Record<string, string> = {
  invalid: "Invalid admin secret.",
  rate_limited: "Too many login attempts. Try again in a minute."
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string; next?: string }> }) {
  const env = getEnv();
  const { error, next } = await searchParams;
  const nextPath = next?.startsWith("/") && !next.startsWith("//") ? next : "/admin/events";
  const errorMessage = error ? errorMessages[error] : null;

  return (
    <main className="shell">
      <div className="container auth-container stack">
        <span className="brand-mark">Score<em>Check</em></span>
        <section className="panel stack">
          <h1>Admin Login</h1>
          {!env.adminSecret && (
            <p className="muted">Set `ADMIN_SECRET` in Vercel before deploying this admin surface publicly.</p>
          )}
          {errorMessage && <p className="form-alert" role="alert">{errorMessage}</p>}
          <form className="stack" action="/api/admin/login" method="post">
            <input type="hidden" name="next" value={nextPath} />
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
