import { describe, expect, it } from "vitest";
import { repositoryConfigSchema } from "../src/config";
import type { ProposedAction, RepositoryEvent } from "../src/domain";
import { GitHubClient, importGitHubPrivateKey } from "../src/github";

const config = repositoryConfigSchema.parse({
  version: 1,
  repository: { description: "test", defaultBranch: "main" },
  search: {},
  metadata: { issueTypes: {}, priorities: {} },
  areas: [],
  autonomy: { automatic: {} },
  budgets: {},
});

const issueEvent: RepositoryEvent = {
  deliveryId: "delivery",
  eventName: "issues",
  action: "opened",
  repository: { installationId: 1, owner: "Org", repo: "Repo", defaultBranch: "main" },
  item: {
    kind: "issue",
    number: 40,
    title: "Duplicate",
    body: "",
    state: "open",
    author: "reporter",
    assignees: [],
    labels: [],
    updatedAt: "2026-08-12T00:00:00Z",
  },
  sender: { login: "reporter", type: "User" },
};

const duplicateAction: ProposedAction = {
  id: "close-40",
  kind: "close_issue",
  target: { owner: "Org", repo: "Repo", number: 40 },
  parameters: { reason: "duplicate", duplicateOf: 39 },
  confidence: 1,
  evidence: [],
  rationale: "The issues describe the same request",
};

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

describe("GitHubClient.addEyesReaction", () => {
  it("adds an idempotent eyes reaction to an issue or pull request", async () => {
    const requests: Array<{ path: string; init: RequestInit }> = [];
    const client = Object.create(GitHubClient.prototype) as GitHubClient;
    client.request = async <T>(path: string, init: RequestInit = {}) => {
      requests.push({ path, init });
      return {} as T;
    };

    await client.addEyesReaction("Org", "Repo", 39);

    expect(requests).toEqual([
      {
        path: "/repos/Org/Repo/issues/39/reactions",
        init: { method: "POST", body: JSON.stringify({ content: "eyes" }) },
      },
    ]);
  });
});

describe("GitHubClient.addManagedComment", () => {
  it("does not publish a second comment with the same marker", async () => {
    const requests: Array<{ path: string; init: RequestInit }> = [];
    const client = Object.create(GitHubClient.prototype) as GitHubClient;
    client.request = async <T>(path: string, init: RequestInit = {}) => {
      requests.push({ path, init });
      if (path.endsWith("/comments?per_page=100")) {
        return [{ body: "Already reported\n\n<!-- conflux-agent:failure-delivery -->" }] as T;
      }
      return {} as T;
    };

    await client.addManagedComment(
      "Org",
      "Repo",
      43,
      "Processing failed.",
      "failure-delivery",
    );

    expect(requests).toEqual([
      { path: "/repos/Org/Repo/issues/43/comments?per_page=100", init: {} },
    ]);
  });
});

describe("GitHubClient.execute", () => {
  it("uses GitHub's native duplicate reason and canonical issue database ID", async () => {
    const requests: Array<{ path: string; init: RequestInit }> = [];
    const client = Object.create(GitHubClient.prototype) as GitHubClient;
    client.request = async <T>(path: string, init: RequestInit = {}) => {
      requests.push({ path, init });
      if (path === "/repos/Org/Repo/issues/39") return { id: 3900 } as T;
      return {} as T;
    };

    await client.execute(duplicateAction, issueEvent, config);

    expect(requests).toEqual([
      { path: "/repos/Org/Repo/issues/39", init: {} },
      {
        path: "/repos/Org/Repo/issues/40",
        init: {
          method: "PATCH",
          body: JSON.stringify({
            state: "closed",
            state_reason: "duplicate",
            duplicate_issue_id: 3900,
          }),
        },
      },
    ]);
  });

  it("does not close the issue when the canonical issue has no valid database ID", async () => {
    const requests: Array<{ path: string; init: RequestInit }> = [];
    const client = Object.create(GitHubClient.prototype) as GitHubClient;
    client.request = async <T>(path: string, init: RequestInit = {}) => {
      requests.push({ path, init });
      return {} as T;
    };

    await expect(client.execute(duplicateAction, issueEvent, config)).rejects.toThrow(
      "canonical issue has no valid database ID",
    );
    expect(requests).toEqual([{ path: "/repos/Org/Repo/issues/39", init: {} }]);
  });
});
