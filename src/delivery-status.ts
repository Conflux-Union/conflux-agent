export function deliveryFailureStatus(error: unknown): string {
  const name = error instanceof Error ? error.name : "Error";
  const message = error instanceof Error ? error.message : String(error);
  const sanitized = `${name}: ${message}`
    .replace(/sk-[A-Za-z0-9_-]{16,}/g, "[REDACTED]")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return `failed:${sanitized}`.slice(0, 500);
}
