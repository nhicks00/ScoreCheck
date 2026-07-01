export function redact(value: unknown): unknown {
  if (typeof value === "string") {
    if (value.length <= 8) return value ? "[redacted]" : "";
    return `${value.slice(0, 4)}...${value.slice(-4)}`;
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
      key,
      /key|secret|token|passphrase|stream/i.test(key) ? redact(entry) : redactNonSecret(entry)
    ]));
  }
  return value;
}

function redactNonSecret(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactNonSecret);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
      key,
      /key|secret|token|passphrase|stream/i.test(key) ? redact(entry) : redactNonSecret(entry)
    ]));
  }
  return value;
}
