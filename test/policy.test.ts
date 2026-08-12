import { describe, expect, it } from "vitest";
import { repositoryConfigSchema } from "../src/config";
import type { ProposedAction, RelationshipCandidate, RepositoryEvent } from "../src/domain";
import { evaluateActions } from "../src/policy";

const config = repositoryConfigSchema.parse({
  version: 1,
  repository: { description: "Test", defaultBranch: "main" },
  search: {},
  metadata: {},
  autonomy: {
    automatic: { closingLinks: true },
    minimumConfidence: 0.9,
  },
  budgets: {},
});

const event: RepositoryEvent = {
  deliveryId: "delivery",
  eventName: "pull_request",
  action: "opened",
  repository: {
    installationId: 1,
    owner: "Conflux-Union",
    repo: "repo",
    defaultBranch: "main",
  },
  item: {
    kind: "pull_request",
    number: 2,
    title: "fix: issue",
    body: "",
    state: "open",
    author: "author",
    assignees: [],
    labels: [],
    updatedAt: "2026-08-12T00:00:00Z",
    baseBranch: "main",
  },
  sender: { login: "author", type: "User" },
};

function relationship(evidenceKinds: RelationshipCandidate["evidence"][number]["kind"][]) {
  return {
    owner: "Conflux-Union",
    repo: "repo",
    number: 1,
    kind: "issue",
    relationship: "resolves",
    confidence: 0.98,
    contentHash: "hash",
    evidence: evidenceKinds.map((kind) => ({ kind, reference: kind, excerpt: "specific evidence" })),
  } satisfies RelationshipCandidate;
}

function linkAction(candidate: RelationshipCandidate): ProposedAction {
  return {
    id: "link",
    kind: "link_closing_issue",
    target: { owner: "Conflux-Union", repo: "repo", number: 2 },
    parameters: { relationship: candidate, baseBranch: "main", issueNumber: 1 },
    confidence: 0.98,
    evidence: candidate.evidence,
    rationale: "The PR fixes the issue",
  };
}

describe("evaluateActions", () => {
  it("automatically links a high-confidence resolution with file and test evidence", () => {
    const result = evaluateActions([linkAction(relationship(["file", "test"]))], event, config);
    expect(result.executable).toHaveLength(1);
    expect(result.pending).toHaveLength(0);
  });

  it("requires approval when deterministic evidence is incomplete", () => {
    const result = evaluateActions([linkAction(relationship(["comment"]))], event, config);
    expect(result.executable).toHaveLength(0);
    expect(result.pending[0]?.requiresApproval).toBe(true);
  });

  it("never directly closes a resolved issue", () => {
    const close: ProposedAction = {
      id: "close",
      kind: "close_issue",
      target: { owner: "Conflux-Union", repo: "repo", number: 1 },
      parameters: { reason: "resolved" },
      confidence: 1,
      evidence: [],
      rationale: "Resolved",
    };
    const result = evaluateActions([close], event, config);
    expect(result.rejected[0]?.reason).toContain("merged pull request");
  });

  it("requires a concrete duplicate relationship before automatically closing", () => {
    const close: ProposedAction = {
      id: "duplicate",
      kind: "close_issue",
      target: { owner: "Conflux-Union", repo: "repo", number: 1 },
      parameters: { reason: "duplicate", duplicateOf: 9 },
      confidence: 1,
      evidence: [],
      rationale: "Duplicate",
    };
    const duplicateConfig = repositoryConfigSchema.parse({
      ...config,
      autonomy: {
        ...config.autonomy,
        automatic: { ...config.autonomy.automatic, duplicate: true },
      },
    });
    const result = evaluateActions([close], event, duplicateConfig);
    expect(result.pending[0]?.requiresApproval).toBe(true);
  });

  it("requires a uniquely configured classified area before assignment", () => {
    const assignment: ProposedAction = {
      id: "assign",
      kind: "set_assignees",
      target: { owner: "Conflux-Union", repo: "repo", number: 1 },
      parameters: { assignees: ["Trirrin"] },
      confidence: 1,
      evidence: [],
      rationale: "Suggested owner",
    };
    const assignmentConfig = repositoryConfigSchema.parse({
      ...config,
      areas: [
        { label: "area/client", paths: ["src/**"], assignees: ["Trirrin"] },
      ],
      autonomy: {
        ...config.autonomy,
        automatic: { ...config.autonomy.automatic, assignment: true },
      },
    });
    const pending = evaluateActions([assignment], event, assignmentConfig);
    expect(pending.pending).toHaveLength(1);

    const classified = evaluateActions(
      [
        {
          ...assignment,
          parameters: { assignees: ["Trirrin"], areaLabels: ["area/client"] },
        },
      ],
      event,
      assignmentConfig,
    );
    expect(classified.executable).toHaveLength(1);
  });
});
