export type BrowserOriginDecision = {
  allowed: boolean;
  corsOrigin: string | null;
};

export function decideBrowserOrigin(
  origin: string | undefined,
  allowedOrigins: readonly string[],
  options: { allowMissing: boolean }
): BrowserOriginDecision {
  if (!origin) {
    return { allowed: options.allowMissing, corsOrigin: null };
  }

  try {
    const normalized = new URL(origin).origin;
    return allowedOrigins.includes(normalized)
      ? { allowed: true, corsOrigin: normalized }
      : { allowed: false, corsOrigin: null };
  } catch {
    return { allowed: false, corsOrigin: null };
  }
}
