export function operationalErrorCode(error: unknown): string {
  if (error && typeof error === "object") {
    const code = boundedCode(Reflect.get(error, "code"));
    if (code) return code;
    const status = Reflect.get(error, "status");
    if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599) return `HTTP_${status}`;
    const name = boundedCode(Reflect.get(error, "name"));
    if (name) return name;
  }
  return "UNKNOWN";
}

function boundedCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const code = value.toUpperCase().replace(/[^A-Z0-9_.:-]+/g, "_").slice(0, 80);
  return code || null;
}
