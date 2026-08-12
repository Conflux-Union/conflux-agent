import { describe, expect, it, vi } from "vitest";
import { repositoryConfigSchema } from "../src/config";
import type { AgentDecision, RepositoryEvent } from "../src/domain";
import {
  historyPath,
  planCommitHistoryAssignment,
  selectDominantCommitter,
} from "../src/assignment";

const config = repositoryConfigSchema.parse({
  version: 1,
  repository: { description: "Test", defaultBranch: "main" },
  search: {},
  metadata: {},
  areas: [{ label: "area/client", paths: ["src/client/**", "common/client/*.java"] }],
  autonomy: {
    automatic: { assignment: true },
    assignment: {
      historyDepth: 30,
      minimumCommits: 3,
      minimumShare: 0.6,
      minimumLead: 2,
    },
  },
  budgets: {},
});

const event: RepositoryEvent = {
  deliveryId: "delivery",
  eventName: "issues",
  action: "opened",
  repository: { installationId: 1, owner: "Org", repo: "Repo", defaultBranch: "main" },
  item: {
    kind: "issue",
    number: 12,
    title: "Client issue",
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
  summary: "Client issue",
  knownFacts: [],
  unresolvedQuestions: [],
  classification: { areaLabels: ["area/client"] },
  relationships: [],
  actions: [],
  conversationStatus: "ready",
};

function commit(sha: string, login: string) {
  return { sha, author: { login }, commit: { message: `Change ${sha}` } };
}

describe("commit-history assignment", () => {
  it("turns configured globs into stable history paths", () => {
    expect(historyPath("src/client/**")).toBe("src/client");
    expect(historyPath("common/client/*.java")).toBe("common/client");
    expect(historyPath("**")).toBeNull();
  });

  it("selects only a committer with a clear recent lead", () => {
    const rules = config.autonomy.assignment;
    expect(
      selectDominantCommitter(
        [
          ...Array.from({ length: 6 }, (_, index) => ({ sha: `a${index}`, login: "owner" })),
          { sha: "b1", login: "other" },
          { sha: "b2", login: "other" },
          { sha: "bot", login: "renovate[bot]" },
          { sha: "a0", login: "owner" },
        ],
        rules,
      )?.login,
    ).toBe("owner");
    expect(
      selectDominantCommitter(
        [
          ...Array.from({ length: 4 }, (_, index) => ({ sha: `a${index}`, login: "owner" })),
          ...Array.from({ length: 3 }, (_, index) => ({ sha: `b${index}`, login: "other" })),
        ],
        rules,
      ),
    ).toBeNull();
  });

  it("plans an assignment from bounded path history and GitHub eligibility", async () => {
    const github = {
      listCommitsForPath: vi
        .fn()
        .mockResolvedValueOnce([
          commit("aaaaaaaa", "Trirrin"),
          commit("bbbbbbbb", "Trirrin"),
          commit("cccccccc", "other"),
        ])
        .mockResolvedValueOnce([
          commit("aaaaaaaa", "Trirrin"),
          commit("dddddddd", "Trirrin"),
          commit("eeeeeeee", "Trirrin"),
        ]),
      canAssign: vi.fn().mockResolvedValue(true),
    };
    const action = await planCommitHistoryAssignment(event, decision, config, github);
    expect(github.listCommitsForPath).toHaveBeenCalledTimes(2);
    expect(action?.parameters).toMatchObject({
      assignees: ["Trirrin"],
      source: "commit_history",
      dominantCommits: 4,
      totalCommits: 5,
      runnerUpCommits: 1,
    });
    expect(action?.evidence.every((entry) => entry.kind === "commit")).toBe(true);
  });

  it("does not assign an already owned or duplicate issue", async () => {
    const github = {
      listCommitsForPath: vi.fn(),
      canAssign: vi.fn(),
    };
    expect(
      await planCommitHistoryAssignment(
        { ...event, item: { ...event.item, assignees: ["Trirrin"] } },
        decision,
        config,
        github,
      ),
    ).toBeNull();
    expect(
      await planCommitHistoryAssignment(
        event,
        {
          ...decision,
          relationships: [
            {
              owner: "Org",
              repo: "Repo",
              number: 1,
              kind: "issue",
              relationship: "duplicate",
              confidence: 0.9,
              evidence: [],
              contentHash: "hash",
            },
          ],
        },
        config,
        github,
      ),
    ).toBeNull();
    expect(github.listCommitsForPath).not.toHaveBeenCalled();
  });
});
