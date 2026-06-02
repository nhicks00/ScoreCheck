import { createClient } from "@supabase/supabase-js";
import { assertSupabaseConfigured, getEnv, missingEnvKeys } from "./env";

export type Row = Record<string, unknown>;

export function isSupabaseConfigured(): boolean {
  return missingEnvKeys().filter((key) => key !== "ADMIN_SECRET").length === 0;
}

export function supabaseAdmin() {
  const env = assertSupabaseConfigured();
  return createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  });
}

export function supabasePublic() {
  const env = getEnv();
  if (!env.supabaseUrl || !env.supabaseAnonKey) {
    return null;
  }
  return createClient(env.supabaseUrl, env.supabaseAnonKey);
}
