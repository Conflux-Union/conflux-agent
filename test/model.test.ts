import { describe, expect, it } from "vitest";
import { repositoryConfigSchema } from "../src/config";
import type { RepositoryEvent } from "../src/domain";
import {
  extractTrustedImageUrls,
  ModelProvider,
  normalizeModelDecision,
  type ModelToolExecutor,
} from "../src/model";
import type { Env } from "../src/env";

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
    assignees: [],
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

  it("preserves native metadata even before its mirror label arrives", async () => {
    const configuredEvent: RepositoryEvent = {
      ...event,
      item: {
        ...event.item,
        nativeIssueType: "Bug",
        nativePriority: "High",
      },
    };
    const decision = await normalizeModelDecision(
      { ...raw, relationships: [] },
      configuredEvent,
      config,
      [],
    );
    expect(decision.classification).toMatchObject({ issueKind: "bug", priority: "P1" });
  });

  it("accepts omitted optional lists and ignores an unusably short title", async () => {
    const decision = await normalizeModelDecision(
      {
        ...raw,
        classification: { issue_kind: "bug" },
        normalized_title: "支持 26.3",
        relationships: undefined,
        actions: undefined,
      },
      event,
      config,
      [],
    );
    expect(decision.classification).toEqual({
      issueKind: "bug",
      priority: undefined,
      areaLabels: [],
    });
    expect(decision.normalizedTitle).toBeUndefined();
    expect(decision.relationships).toEqual([]);
    expect(decision.actions).toEqual([]);
  });

  it("ignores model-selected assignees", async () => {
    const decision = await normalizeModelDecision(
      {
        ...raw,
        relationships: [],
        actions: [
          {
            kind: "set_assignees",
            confidence: 1,
            rationale: "The author is a maintainer",
            parameters: { assignees: ["Trirrin"] },
          },
        ],
      },
      event,
      config,
      [],
    );
    expect(decision.actions).toEqual([]);
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

describe("ModelProvider", () => {
  it("lets the model explore with tools before returning its decision", async () => {
    const requests: Array<{
      url: string;
      headers: Record<string, string>;
      body: Record<string, any>;
    }> = [];
    const responses = [
      {
        id: "msg-1",
        type: "message",
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "I need to find the implementation first.",
            signature: "signed-thinking",
          },
          {
            type: "tool_use",
            id: "toolu-1",
            name: "search_code",
            input: { query: "renderMinimap" },
          },
        ],
        stop_reason: "tool_use",
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          cache_creation_input_tokens: 10,
          cache_read_input_tokens: 40,
        },
      },
      {
        id: "msg-2",
        type: "message",
        role: "assistant",
        content: [
          {
            type: "text",
            text: JSON.stringify({
                ...raw,
                disposition: "reply",
                reply: "The minimap is rendered by src/client/map.ts.",
                relationships: [],
            }),
          },
        ],
        stop_reason: "end_turn",
        usage: {
          input_tokens: 120,
          output_tokens: 30,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 60,
        },
      },
    ];
    const request = async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        url: String(input),
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        body: JSON.parse(String(init?.body)),
      });
      return new Response(JSON.stringify(responses.shift()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    const tools: ModelToolExecutor = {
      definitions: [
        {
          type: "function",
          function: {
            name: "search_code",
            description: "Search repository code",
            parameters: {
              type: "object",
              properties: { query: { type: "string" } },
              required: ["query"],
              additionalProperties: false,
            },
          },
        },
      ],
      async execute(call) {
        calls.push(call);
        return { matches: [{ path: "src/client/map.ts" }] };
      },
      candidates: () => [],
      cachedRelationships: () => [],
    };
    const provider = new ModelProvider(
      {
        MODEL_BASE_URL: "https://model.example/anthropic",
        MODEL_NAME: "mimo-v2.5",
        MODEL_API_KEY: "secret",
        PROMPT_VERSION: "test",
      } as Env,
      request,
    );

    const result = await provider.decide({
      event: {
        ...event,
        item: {
          ...event.item,
          body: "![render](https://github.com/user-attachments/assets/render-123)",
        },
      },
      state: {
        contentVersion: "",
        summary: "",
        knownFacts: [],
        unresolvedQuestions: [],
        classification: { areaLabels: [] },
        relatedItems: [],
        pendingActions: [],
        conversationStatus: "active",
        manualOverrides: [],
        tokenUsage: {
          inputTokens: 0,
          outputTokens: 0,
          cachedInputTokens: 0,
          modelCalls: 0,
        },
      },
      config: repositoryConfigSchema.parse({
        ...config,
        budgets: { maxModelCallsPerEvent: 2 },
      }),
      tools,
    });

    expect(calls).toEqual([{ name: "search_code", arguments: { query: "renderMinimap" } }]);
    expect(requests).toHaveLength(2);
    expect(requests[0]?.url).toBe("https://model.example/anthropic/v1/messages");
    expect(requests[0]?.headers).toMatchObject({
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
      "x-api-key": "secret",
    });
    expect(requests[0]?.body).toMatchObject({
      model: "mimo-v2.5",
      max_tokens: 2500,
      system: expect.any(String),
      tool_choice: { type: "auto" },
      tools: [
        {
          name: "search_code",
          description: "Search repository code",
          input_schema: tools.definitions[0]?.function.parameters,
        },
      ],
    });
    expect(requests[0]?.body.messages[0]).toMatchObject({
      role: "user",
      content: [
        {
          type: "image",
          source: {
            type: "url",
            url: "https://github.com/user-attachments/assets/render-123",
          },
        },
        { type: "text", text: expect.any(String) },
      ],
    });
    expect(requests[1]?.body.messages.slice(-2)).toEqual([
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "I need to find the implementation first.",
            signature: "signed-thinking",
          },
          {
            type: "tool_use",
            id: "toolu-1",
            name: "search_code",
            input: { query: "renderMinimap" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu-1",
            content: JSON.stringify({ matches: [{ path: "src/client/map.ts" }] }),
          },
        ],
      },
    ]);
    expect(requests[1]?.body.tool_choice).toEqual({ type: "none" });
    expect(result.decision.reply).toContain("src/client/map.ts");
    expect(result.usage).toMatchObject({
      modelCalls: 2,
      inputTokens: 330,
      outputTokens: 50,
      cachedInputTokens: 100,
    });
  });
});
