export async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function verifyWebhookSignature(
  body: string,
  signature: string | null,
  secret: string,
): Promise<boolean> {
  if (!signature?.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const expected = signature.slice("sha256=".length);
  if (!/^[a-f0-9]{64}$/i.test(expected)) return false;
  const bytes = Uint8Array.from(expected.match(/.{2}/g) ?? [], (value) => Number.parseInt(value, 16));
  return crypto.subtle.verify("HMAC", key, bytes, new TextEncoder().encode(body));
}
