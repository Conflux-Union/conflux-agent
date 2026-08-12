import { describe, expect, it } from "vitest";
import { importGitHubPrivateKey } from "../src/github";

async function exportPrivateKey(type: "pkcs1" | "pkcs8"): Promise<string> {
  const generated = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", generated.privateKey));
  if (type === "pkcs8") return toPem("PRIVATE KEY", pkcs8);
  return toPem("RSA PRIVATE KEY", unwrapPkcs8(pkcs8));
}

function readLength(der: Uint8Array, offset: number): { length: number; next: number } {
  const first = der[offset]!;
  if (first < 0x80) return { length: first, next: offset + 1 };
  const count = first & 0x7f;
  let length = 0;
  for (let index = 0; index < count; index++) {
    length = (length << 8) | der[offset + 1 + index]!;
  }
  return { length, next: offset + 1 + count };
}

function unwrapPkcs8(der: Uint8Array): Uint8Array {
  const sequence = readLength(der, 1);
  let offset = sequence.next;
  const version = readLength(der, offset + 1);
  offset = version.next + version.length;
  const algorithm = readLength(der, offset + 1);
  offset = algorithm.next + algorithm.length;
  const privateKey = readLength(der, offset + 1);
  return der.slice(privateKey.next, privateKey.next + privateKey.length);
}

function toPem(label: string, der: Uint8Array): string {
  let binary = "";
  for (const byte of der) binary += String.fromCharCode(byte);
  const base64 = btoa(binary).match(/.{1,64}/g)?.join("\n") ?? "";
  return `-----BEGIN ${label}-----\n${base64}\n-----END ${label}-----`;
}

describe("importGitHubPrivateKey", () => {
  it("accepts the PKCS#1 PEM format downloaded from GitHub Apps", async () => {
    const pem = await exportPrivateKey("pkcs1");

    await expect(importGitHubPrivateKey(pem)).resolves.toBeDefined();
  });

  it("accepts PKCS#8 PEM with escaped newlines", async () => {
    const pem = (await exportPrivateKey("pkcs8")).replaceAll("\n", "\\n");

    await expect(importGitHubPrivateKey(pem)).resolves.toBeDefined();
  });
});
