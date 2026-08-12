import { describe, expect, it } from "vitest";
import { repositoryConfigSchema } from "../src/config";
import type { RepositoryEvent } from "../src/domain";
import { extractTrustedImageUrls, normalizeModelDecision } from "../src/model";

const config = repositoryConfigSchema.parse({
  version: 1,
  repository: { description: "test", defaultBranch: "main" },
  search: {},
  metadata: {
    issueTypes: { bug: { label: "bug", fieldValue: "Bug" } },
    priorities: { P1: { label: "P1", fieldValue: "High" } },
  },
  areas: [{ label: "area/client", paths: ["src/client/**"] }],
  autonomy: { automatic: {} },
  budgets: {},
});

const event: RepositoryEvent = {
  deliveryId: "delivery",
  eventName: "pull_request",
  action: "opened",
  repository: { installationId: 1, owner: "Org", repo: "Repo", defaultBranch: "main" },
  item: {
    kind: "pull_request",
    number: 2,
    title: "Fix",
    body: "",
    state: "open",
    author: "author",
    labels: [],
    updatedAt: "2026-08-12T00:00:00Z",
  },
  sender: { login: "author", type: "User" },
};

const raw = {
  disposition: "act",
  summary: "A compact summary",
  known_facts: [],
  unresolved_questions: [],
  classification: {
    issue_kind: "invented",
    priority: "P1",
    area_labels: ["area/client", "area/invented"],
  },
  relationships: [
    {
      candidate_index: 0,
      relationship: "resolves",
      confidence: 0.99,
      rationale: "The fix and test cover the same behavior",
      matched_files: ["src/client/Fix.ts", "invented.ts"],
      matched_tests: ["test/client/Fix.test.ts", "invented.test.ts"],
    },
  ],
  actions: [],
  conversation_status: "ready",
};

describe("normalizeModelDecision", () => {
  it("accepts only configured metadata and evidence paths present in GitHub data", async () => {
    const decision = await normalizeModelDecision(raw, event, config, [
      {
        owner: "Org",
        repo: "Repo",
        number: 1,
        kind: "issue",
        title: "Issue",
        summary: "Summary",
        state: "open",
        contentHash: "hash",
        files: ["src/client/Fix.ts", "test/client/Fix.test.ts"],
      },
    ]);
    expect(decision.classification).toEqual({
      issueKind: undefined,
      priority: "P1",
      areaLabels: ["area/client"],
    });
    expect(decision.relationships[0]?.evidence.map((entry) => entry.reference)).toEqual([
      "Org/Repo#1",
      "src/client/Fix.ts",
      "test/client/Fix.test.ts",
    ]);
  });

  it("preserves human-managed metadata already present on the item", async () => {
    const configuredEvent: RepositoryEvent = {
      ...event,
      item: { ...event.item, labels: ["bug", "area/client"] },
    };
    const decision = await normalizeModelDecision(
      {
        ...raw,
        classification: { issue_kind: undefined, priority: undefined, area_labels: [] },
        relationships: [],
      },
      configuredEvent,
      config,
      [],
    );
    expect(decision.classification).toMatchObject({
      issueKind: "bug",
      areaLabels: ["area/client"],
    });
  });
});

describe("extractTrustedImageUrls", () => {
  it("accepts only trusted GitHub attachments and deduplicates them", () => {
    expect(
      extractTrustedImageUrls([
        "![one](https://github.com/user-attachments/assets/abc-123)",
        "https://example.com/private.png https://github.com/user-attachments/assets/abc-123",
      ]),
    ).toEqual(["https://github.com/user-attachments/assets/abc-123"]);
  });
});
