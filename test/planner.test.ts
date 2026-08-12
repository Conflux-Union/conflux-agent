import { describe, expect, it } from "vitest";
import { repositoryConfigSchema } from "../src/config";
import {
  INITIAL_THREAD_STATE,
  type AgentDecision,
  type RepositoryEvent,
} from "../src/domain";
import { planActions } from "../src/planner";

const config = repositoryConfigSchema.parse({
  version: 1,
  repository: { description: "Test", defaultBranch: "main" },
  search: {},
  metadata: {},
  autonomy: { automatic: {} },
  budgets: {},
});

const event: RepositoryEvent = {
  deliveryId: "delivery",
  eventName: "issues",
  action: "opened",
  repository: { installationId: 1, owner: "Org", repo: "Repo", defaultBranch: "main" },
  item: {
    kind: "issue",
    number: 9,
    title: "Issue created after the pull request",
    body: "",
    state: "open",
    author: "reporter",
    assignees: [],
    labels: [],
    updatedAt: "2026-08-12T00:00:00Z",
  },
  sender: { login: "reporter", type: "User" },
};

const decision: AgentDecision = {
  disposition: "act",
  summary: "The earlier pull request resolves the new issue.",
  knownFacts: [],
  unresolvedQuestions: [],
  classification: { areaLabels: [] },
  relationships: [
    {
      owner: "Org",
      repo: "Repo",
      number: 4,
      kind: "pull_request",
      relationship: "resolves",
      confidence: 0.98,
      contentHash: "hash",
      evidence: [
        { kind: "pull_request", reference: "Org/Repo#4", excerpt: "main" },
        { kind: "file", reference: "src/Fix.ts", excerpt: "same behavior" },
        { kind: "test", reference: "test/Fix.test.ts", excerpt: "same behavior" },
      ],
    },
  ],
  actions: [],
  conversationStatus: "ready",
};

describe("planActions", () => {
  it("links an earlier pull request when the issue is created later", async () => {
    const actions = await planActions(event, INITIAL_THREAD_STATE, decision, config);
    const link = actions.find((action) => action.kind === "link_closing_issue");
    expect(link?.target.number).toBe(4);
    expect(link?.parameters).toMatchObject({ issueNumber: 9, baseBranch: "main" });
  });

  it("assigns the sole configured owner for a classified area", async () => {
    const ownershipConfig = repositoryConfigSchema.parse({
      ...config,
      areas: [{ label: "area/client", paths: ["src/**"], assignees: ["Trirrin"] }],
      autonomy: { automatic: { assignment: true } },
    });
    const ownedDecision: AgentDecision = {
      ...decision,
      relationships: [],
      classification: { areaLabels: ["area/client"] },
    };
    const actions = await planActions(
      event,
      INITIAL_THREAD_STATE,
      ownedDecision,
      ownershipConfig,
    );
    expect(actions.find((action) => action.kind === "set_assignees")?.parameters).toEqual({
      assignees: ["Trirrin"],
      areaLabels: ["area/client"],
    });
  });

  it("always targets the current pull request when it resolves an issue", async () => {
    const pullEvent: RepositoryEvent = {
      ...event,
      eventName: "pull_request",
      item: {
        ...event.item,
        kind: "pull_request",
        number: 10,
        baseBranch: "main",
      },
    };
    const pullDecision: AgentDecision = {
      ...decision,
      relationships: [
        {
          ...decision.relationships[0]!,
          owner: "Other-Owner",
          repo: "other-repo",
          number: 9,
          kind: "issue",
        },
      ],
    };
    const actions = await planActions(
      pullEvent,
      INITIAL_THREAD_STATE,
      pullDecision,
      config,
    );
    const link = actions.find((action) => action.kind === "link_closing_issue");
    expect(link?.target).toEqual({ owner: "Org", repo: "Repo", number: 10 });
  });
});
