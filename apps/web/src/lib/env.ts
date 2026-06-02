export type AppEnv = {
  supabaseUrl: string;
  supabaseAnonKey: string;
  supabaseServiceRoleKey: string;
  adminSecret: string;
  publicSiteUrl: string;
};

export function getEnv(): AppEnv {
  return {
    supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
    supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
    supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
    adminSecret: process.env.ADMIN_SECRET ?? "",
    publicSiteUrl: process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000"
  };
}

export function missingEnvKeys(): string[] {
  const env = getEnv();
  return [
    ["NEXT_PUBLIC_SUPABASE_URL", env.supabaseUrl],
    ["NEXT_PUBLIC_SUPABASE_ANON_KEY", env.supabaseAnonKey],
    ["SUPABASE_SERVICE_ROLE_KEY", env.supabaseServiceRoleKey],
    ["ADMIN_SECRET", env.adminSecret]
  ]
    .filter(([, value]) => !value)
    .map(([key]) => key);
}

export function assertConfigured(): AppEnv {
  const missing = missingEnvKeys();
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }
  return getEnv();
}

export function assertSupabaseConfigured(): AppEnv {
  const env = getEnv();
  const missing = [
    ["NEXT_PUBLIC_SUPABASE_URL", env.supabaseUrl],
    ["NEXT_PUBLIC_SUPABASE_ANON_KEY", env.supabaseAnonKey],
    ["SUPABASE_SERVICE_ROLE_KEY", env.supabaseServiceRoleKey]
  ]
    .filter(([, value]) => !value)
    .map(([key]) => key);
  if (missing.length > 0) {
    throw new Error(`Missing required Supabase environment variables: ${missing.join(", ")}`);
  }
  return env;
}
