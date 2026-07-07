import { missingEnvKeys } from "@/lib/env";

export function SetupNotice() {
  const missing = missingEnvKeys();
  if (missing.length === 0) return null;
  return (
    <div className="panel warn-surface stack" role="status">
      <h2>Deployment setup needed</h2>
      <p>
        Add these environment variables in Vercel and apply the Supabase migration before using the cloud app.
      </p>
      <div className="stack">
        {missing.map((key) => (
          <code key={key}>{key}</code>
        ))}
      </div>
    </div>
  );
}
