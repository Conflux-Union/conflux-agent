import { describe, expect, it } from "vitest";
import { repositoryConfigSchema } from "../src/config";
import type { RepositoryEvent } from "../src/domain";
import { RepositoryToolbox, type RepositoryReader } from "../src/repository-tools";

const event: RepositoryEvent = {
  deliveryId: "delivery",
  eventName: "issues",
  action: "opened",
  repository: { installationId: 1, owner: "Org", repo: "Repo", defaultBranch: "main" },
  item: {
    kind: "issue",
    number: 7,
    title: "Minimap is blank",
    body: "The minimap is blank after joining a server.",
    state: "open",
    author: "reporter",
    assignees: [],
    labels: [],
    updatedAt: "2026-08-12T00:00:00Z",
  },
  sender: { login: "reporter", type: "User" },
};

const config = repositoryConfigSchema.parse({
  version: 1,
  repository: { description: "test", defaultBranch: "main" },
  search: { repositories: ["Org/Docs"] },
  metadata: {},
  autonomy: { automatic: {} },
  budgets: { maxToolCallsPerEvent: 2, maxToolResultCharacters: 5000 },
});

function reader(overrides: Partial<RepositoryReader> = {}): RepositoryReader {
  return {
    async searchCode() {
      return {
        items: [
          {
            name: "map.ts",
            path: "src/client/map.ts",
            sha: "abc123",
            text_matches: [{ fragment: "function renderMinimap() {}" }],
          },
        ],
      };
    },
    async getContent() {
      return {
        type: "file",
        path: "src/client/map.ts",
        sha: "abc123",
        encoding: "base64",
        content: btoa("one\ntwo\nthree\nfour"),
      };
    },
    async searchIssuesAndPulls() {
      return { items: [] };
    },
    async getIssue() {
      return {};
    },
    async getPull() {
      return {};
    },
    async listComments() {
      return [];
    },
    async listPullFiles() {
      return [];
    },
    async listCommitsForPath() {
      return [];
    },
    ...overrides,
  };
}

describe("RepositoryToolbox", () => {
  it("searches code and reads a bounded line range through one public tool seam", async () => {
    const toolbox = new RepositoryToolbox(event, config, reader());

    await expect(
      toolbox.execute({
        name: "search_code",
        arguments: { query: "renderMinimap", path: "src/client" },
      }),
    ).resolves.toEqual({
      repository: "Org/Repo",
      matches: [
        {
          path: "src/client/map.ts",
          sha: "abc123",
          fragments: ["function renderMinimap() {}"],
        },
      ],
    });
    await expect(
      toolbox.execute({
        name: "read_file",
        arguments: { path: "src/client/map.ts", start_line: 2, end_line: 3 },
      }),
    ).resolves.toEqual({
      repository: "Org/Repo",
      path: "src/client/map.ts",
      ref: "main",
      sha: "abc123",
      start_line: 2,
      end_line: 3,
      content: "two\nthree",
    });
  });

  it("rejects repositories outside the configured read allowlist and enforces the call budget", async () => {
    const toolbox = new RepositoryToolbox(event, config, reader());

    await expect(
      toolbox.execute({
        name: "read_file",
        arguments: { repository: "Other/Private", path: "secret.txt" },
      }),
    ).rejects.toThrow("Repository is not allowed");
    await toolbox.execute({ name: "search_code", arguments: { query: "one" } });
    await expect(
      toolbox.execute({ name: "search_code", arguments: { query: "two" } }),
    ).rejects.toThrow("Tool-call budget exhausted");
  });

  it("assigns stable candidate indexes to inspected threads for relationship evidence", async () => {
    const toolbox = new RepositoryToolbox(
      event,
      config,
      reader({
        async searchIssuesAndPulls() {
          return {
            items: [
              {
                number: 12,
                title: "Fix blank minimap",
                body: "Fixes the render state.",
                state: "open",
                updated_at: "2026-08-12T01:00:00Z",
                repository_url: "https://api.github.com/repos/Org/Repo",
                pull_request: { url: "https://api.github.com/repos/Org/Repo/pulls/12" },
              },
            ],
          };
        },
      }),
    );

    const first = await toolbox.execute({
      name: "search_threads",
      arguments: { query: "blank minimap" },
    });
    const second = await toolbox.execute({
      name: "search_threads",
      arguments: { query: "render state" },
    });

    expect(first).toMatchObject({ matches: [{ candidate_index: 0, number: 12 }] });
    expect(second).toMatchObject({ matches: [{ candidate_index: 0, number: 12 }] });
    expect(toolbox.candidates()).toEqual([
      expect.objectContaining({ owner: "Org", repo: "Repo", number: 12, kind: "pull_request" }),
    ]);
  });

  it("attaches current pull request files to issue candidates regardless of exploration order", async () => {
    const pullEvent: RepositoryEvent = {
      ...event,
      eventName: "pull_request",
      item: { ...event.item, kind: "pull_request", number: 20 },
    };
    const toolbox = new RepositoryToolbox(
      pullEvent,
      repositoryConfigSchema.parse({
        ...config,
        budgets: { maxToolCallsPerEvent: 4, maxToolResultCharacters: 5000 },
      }),
      reader({
        async getIssue(_owner, _repo, number) {
          return number === 20
            ? { number, title: "Fix", body: "", state: "open", pull_request: {} }
            : { number, title: "Bug", body: "Blank map", state: "open" };
        },
        async getPull() {
          return { body: "Fixes #7", head: { sha: "head" }, base: { ref: "main" } };
        },
        async listPullFiles() {
          return [
            { filename: "src/map.ts", patch: "+fix" },
            { filename: "test/map.test.ts", patch: "+test" },
          ];
        },
      }),
    );

    await toolbox.execute({ name: "inspect_thread", arguments: { number: 7 } });
    await toolbox.execute({ name: "inspect_thread", arguments: { number: 20 } });

    expect(toolbox.candidates()[0]).toMatchObject({
      kind: "issue",
      files: ["src/map.ts", "test/map.test.ts"],
      filePatches: [
        { path: "src/map.ts", patch: "+fix" },
        { path: "test/map.test.ts", patch: "+test" },
      ],
    });
  });
});
