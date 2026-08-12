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
  it("publishes a repository-backed answer to a question without escalating", async () => {
    const questionConfig = repositoryConfigSchema.parse({
      ...config,
      repository: {
        ...config.repository,
        maintainers: ["Trirrin", "map-maintainer"],
      },
      metadata: {
        issueTypes: { question: { label: "question", fieldValue: "Task" } },
      },
    });
    const answer =
      "The setting controls minimap zoom; `src/config/MapConfig.ts` defines its range.";
    const actions = await planActions(
      event,
      INITIAL_THREAD_STATE,
      {
        ...decision,
        disposition: "reply",
        reply: answer,
        classification: { issueKind: "question", areaLabels: [] },
        relationships: [],
      },
      questionConfig,
    );

    const comment = actions.find((action) => action.kind === "comment");
    expect(comment?.parameters.body).toBe(answer);
    expect(comment?.parameters.body).not.toContain("@Trirrin");
  });

  it("mentions every configured maintainer when a repository question cannot be answered", async () => {
    const questionConfig = repositoryConfigSchema.parse({
      ...config,
      repository: {
        ...config.repository,
        maintainers: ["Trirrin", "map-maintainer"],
      },
      metadata: {
        issueTypes: { question: { label: "question", fieldValue: "Task" } },
      },
    });
    const actions = await planActions(
      event,
      INITIAL_THREAD_STATE,
      {
        ...decision,
        disposition: "escalate",
        reply: "I could not find the answer. Please investigate it for me.",
        classification: { issueKind: "question", areaLabels: [] },
        relationships: [],
        conversationStatus: "escalated",
      },
      questionConfig,
    );

    const comment = actions.find((action) => action.kind === "comment");
    expect(comment?.parameters.body).toBe(
      "@Trirrin @map-maintainer I couldn't find a reliable answer in the repository evidence. Could you answer this question?",
    );
  });

  it("escalates an unanswered Chinese question without guessing maintainer logins", async () => {
    const questionConfig = repositoryConfigSchema.parse({
      ...config,
      metadata: {
        issueTypes: { question: { label: "question", fieldValue: "Task" } },
      },
    });
    const actions = await planActions(
      { ...event, item: { ...event.item, body: "这个配置有什么作用？" } },
      INITIAL_THREAD_STATE,
      {
        ...decision,
        disposition: "escalate",
        reply: "请告诉我应该如何实现。",
        classification: { issueKind: "question", areaLabels: [] },
        relationships: [],
        conversationStatus: "escalated",
      },
      questionConfig,
    );

    const comment = actions.find((action) => action.kind === "comment");
    expect(comment?.parameters.body).toBe(
      "我无法从仓库代码和文档中找到可靠答案，请协助回答这个问题。",
    );
    expect(comment?.parameters.body).not.toContain("@");
    expect(comment?.parameters.body).not.toContain("实现");
  });

  it("replaces an off-topic model reply with a fixed refusal", async () => {
    const actions = await planActions(
      { ...event, comment: { id: 1, body: "讲个冷笑话", author: "reporter", updatedAt: event.item.updatedAt } },
      INITIAL_THREAD_STATE,
      {
        ...decision,
        disposition: "reply",
        requestScope: "off_topic",
        reply: "A model-generated joke that must not be posted",
        actions: [
          {
            id: "unsafe",
            kind: "set_milestone",
            target: { owner: "Org", repo: "Repo", number: 9 },
            parameters: { title: "Unrelated" },
            confidence: 1,
            evidence: [],
            rationale: "Unsafe off-topic side effect",
          },
        ],
      },
      config,
    );
    expect(actions).toHaveLength(1);
    expect(actions[0]?.kind).toBe("comment");
    expect(actions[0]?.parameters.body).toContain("只处理与本仓库代码");
    expect(actions[0]?.parameters.body).not.toContain("model-generated joke");
  });

  it("links an earlier pull request when the issue is created later", async () => {
    const actions = await planActions(event, INITIAL_THREAD_STATE, decision, config);
    const link = actions.find((action) => action.kind === "link_closing_issue");
    expect(link?.target.number).toBe(4);
    expect(link?.parameters).toMatchObject({ issueNumber: 9, baseBranch: "main" });
  });

  it("does not infer assignees from static area configuration", async () => {
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
    expect(actions.find((action) => action.kind === "set_assignees")).toBeUndefined();
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
