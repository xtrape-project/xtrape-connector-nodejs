// Keep this aligned with @xtrape/opstage-shared#redactSecrets so the SDK and
// the Platform redact the same fields. SDK side is, if anything, more exposed
// (it sees vendor cookies, API keys, generated secrets) so we widen, not narrow.
const SENSITIVE_KEY = /token|secret|password|cookie|authorization|api[-_]?key\b|generatedKey|rawKey|plainTextKey/i;
const TOKEN_PATTERN = /opstage_[a-z]+_[A-Za-z0-9_-]+/g;

export function redact(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(TOKEN_PATTERN, (match) => {
      const prefixEnd = match.lastIndexOf("_");
      return `${match.slice(0, prefixEnd + 1)}[REDACTED]`;
    });
  }
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(redact);
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([k, v]) =>
      SENSITIVE_KEY.test(k) ? [k, "[REDACTED]"] : [k, redact(v)]
    )
  );
}
