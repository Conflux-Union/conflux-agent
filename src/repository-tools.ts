import { z } from "zod";
import type { RepositoryConfig } from "./config";
import type { RelationshipCandidate, RepositoryEvent } from "./domain";
import type {
  CandidateContext,
  ModelToolDefinition,
  ModelToolExecutor,
} from "./model";
import { relationshipComparisonHash } from "./model";

export interface RelationshipCache {
  cachedRelationship(
    source: RepositoryEvent,
    candidate: CandidateContext,
    comparisonHash: string,
  ): Promise<RelationshipCandidate | null>;
}

type GitHubRecord = Record<string, any>;

export interface RepositoryReader {
  searchCode(owner: string, repo: string, query: string, path?: string): Promise<GitHubRecord>;
  getContent(owner: string, repo: string, path: string, ref?: string): Promise<GitHubRecord | GitHubRecord[]>;
  searchIssuesAndPulls(query: string): Promise<{ items: GitHubRecord[] }>;
  getIssue(owner: string, repo: string, number: number): Promise<GitHubRecord>;
  getPull(owner: string, repo: string, number: number): Promise<GitHubRecord>;
  listComments(owner: string, repo: string, number: number, since?: string): Promise<GitHubRecord[]>;
  listPullFiles(owner: string, repo: string, number: number): Promise<GitHubRecord[]>;
  listCommitsForPath(owner: string, repo: string, path: string, perPage: number): Promise<GitHubRecord[]>;
}

const repositoryArgument = z.string().regex(/^[^/\s]+\/[^/\s]+$/).optional();
const pathArgument = z
  .string()
  .max(500)
  .refine((path) => !path.startsWith("/") && !path.split("/").includes(".."), {
    message: "Path must be repository-relative and cannot contain '..'",
  });

const schemas = {
  search_code: z.object({
    query: z.string().min(1).max(500),
    path: pathArgument.optional(),
    repository: repositoryArgument,
  }),
  read_file: z.object({
    path: pathArgument,
    ref: z.string().min(1).max(200).optional(),
    start_line: z.number().int().positive().optional(),
    end_line: z.number().int().positive().optional(),
    repository: repositoryArgument,
  }),
  list_directory: z.object({
    path: pathArgument.optional(),
    ref: z.string().min(1).max(200).optional(),
    repository: repositoryArgument,
  }),
  search_threads: z.object({
    query: z.string().min(1).max(500),
    kind: z.enum(["issue", "pull_request", "any"]).default("any"),
    state: z.enum(["open", "closed", "all"]).default("all"),
    repository: repositoryArgument,
  }),
  inspect_thread: z.object({
    number: z.number().int().positive(),
    repository: repositoryArgument,
  }),
  list_commits: z.object({
    path: pathArgument,
    limit: z.number().int().min(1).max(30).default(10),
    repository: repositoryArgument,
  }),
};

export const REPOSITORY_TOOL_DEFINITIONS: ModelToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "search_code",
      description: "Search exact symbols or text in repository source code. Use this before reading files when the implementation path is unknown.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Code text or symbol to search for" },
          path: { type: "string", description: "Optional repository-relative path prefix" },
          repository: { type: "string", description: "Optional allowed owner/repo; defaults to the current repository" },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a bounded line range from one repository file. Search first when the path is uncertain.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          ref: { type: "string", description: "Branch, tag, or commit; defaults to the repository default branch" },
          start_line: { type: "integer", minimum: 1 },
          end_line: { type: "integer", minimum: 1 },
          repository: { type: "string" },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_directory",
      description: "List files and directories at a repository path without reading their contents.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          ref: { type: "string" },
          repository: { type: "string" },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_threads",
      description: "Search issues and pull requests in the current or explicitly allowed repository. Results receive candidate_index values for relationship decisions.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          kind: { type: "string", enum: ["issue", "pull_request", "any"] },
          state: { type: "string", enum: ["open", "closed", "all"] },
          repository: { type: "string" },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "inspect_thread",
      description: "Inspect one issue or pull request, including comments and, for a pull request, changed files and bounded patches. Returns a candidate_index for relationship decisions.",
      parameters: {
        type: "object",
        properties: {
          number: { type: "integer", minimum: 1 },
          repository: { type: "string" },
        },
        required: ["number"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_commits",
      description: "Inspect recent commits affecting one repository path for ownership or historical context.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 30 },
          repository: { type: "string" },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
];

function decodeBase64(value: string): string {
  const bytes = Uint8Array.from(atob(value.replace(/\s/g, "")), (character) =>
    character.charCodeAt(0),
  );
  return new TextDecoder().decode(bytes);
}

function repositoryFromUrl(url: string): { owner: string; repo: string } | null {
  const match = url.match(/\/repos\/([^/]+)\/([^/]+)$/);
  return match?.[1] && match[2] ? { owner: match[1], repo: match[2] } : null;
}

export class RepositoryToolbox implements ModelToolExecutor {
  readonly definitions = REPOSITORY_TOOL_DEFINITIONS;
  private callCount = 0;
  private readonly candidateList: CandidateContext[] = [];
  private readonly candidateIndexes = new Map<string, number>();
  private readonly reusedRelationships = new Map<string, RelationshipCandidate>();
  private readonly allowedRepositories: Map<string, { owner: string; repo: string }>;
  private currentPullFiles?: Array<{ path: string; patch?: string }>;

  constructor(
    private readonly event: RepositoryEvent,
    private readonly config: RepositoryConfig,
    private readonly reader: RepositoryReader,
    private readonly relationshipCache?: RelationshipCache,
  ) {
    const repositories = [
      `${event.repository.owner}/${event.repository.repo}`,
      ...config.search.repositories,
    ];
    this.allowedRepositories = new Map(
      repositories.map((repository) => {
        const [owner, repo] = repository.split("/");
        if (!owner || !repo) throw new Error(`Invalid configured repository: ${repository}`);
        return [repository.toLowerCase(), { owner, repo }];
      }),
    );
  }

  candidates(): CandidateContext[] {
    return [...this.candidateList];
  }

  cachedRelationships(): RelationshipCandidate[] {
    return [...this.reusedRelationships.values()];
  }

  async execute(call: { name: string; arguments: Record<string, unknown> }): Promise<unknown> {
    this.callCount += 1;
    if (this.callCount > this.config.budgets.maxToolCallsPerEvent) {
      throw new Error("Tool-call budget exhausted");
    }
    const schema = schemas[call.name as keyof typeof schemas];
    if (!schema) throw new Error(`Unknown repository tool: ${call.name}`);
    const input = schema.parse(call.arguments) as Record<string, any>;
    const repository = this.resolveRepository(input.repository);
    let result: unknown;
    switch (call.name) {
      case "search_code":
        result = await this.searchCode(repository, input);
        break;
      case "read_file":
        result = await this.readFile(repository, input);
        break;
      case "list_directory":
        result = await this.listDirectory(repository, input);
        break;
      case "search_threads":
        result = await this.searchThreads(repository, input);
        break;
      case "inspect_thread":
        result = await this.inspectThread(repository, input.number);
        break;
      case "list_commits":
        result = await this.listCommits(repository, input.path, input.limit);
        break;
      default:
        throw new Error(`Unknown repository tool: ${call.name}`);
    }
    return this.boundResult(result);
  }

  private resolveRepository(value?: string): { owner: string; repo: string } {
    const requested = value ?? `${this.event.repository.owner}/${this.event.repository.repo}`;
    const repository = this.allowedRepositories.get(requested.toLowerCase());
    if (!repository) throw new Error(`Repository is not allowed: ${requested}`);
    return repository;
  }

  private async searchCode(repository: { owner: string; repo: string }, input: any) {
    const response = await this.reader.searchCode(
      repository.owner,
      repository.repo,
      input.query,
      input.path,
    );
    const expected = `${repository.owner}/${repository.repo}`.toLowerCase();
    const matches = (Array.isArray(response.items) ? response.items : [])
      .filter((item: GitHubRecord) => {
        const fullName = String(item.repository?.full_name ?? expected).toLowerCase();
        return fullName === expected;
      })
      .slice(0, 20)
      .map((item: GitHubRecord) => ({
        path: String(item.path ?? item.name ?? ""),
        sha: String(item.sha ?? ""),
        fragments: Array.isArray(item.text_matches)
          ? item.text_matches.slice(0, 5).map((match: GitHubRecord) => String(match.fragment ?? ""))
          : [],
      }));
    return { repository: `${repository.owner}/${repository.repo}`, matches };
  }

  private async readFile(repository: { owner: string; repo: string }, input: any) {
    const ref = input.ref ?? this.config.repository.defaultBranch;
    const response = await this.reader.getContent(repository.owner, repository.repo, input.path, ref);
    if (Array.isArray(response) || response.type !== "file" || response.encoding !== "base64") {
      throw new Error(`Path is not a readable file: ${input.path}`);
    }
    const lines = decodeBase64(String(response.content ?? "")).split("\n");
    const start = Math.min(input.start_line ?? 1, Math.max(lines.length, 1));
    const requestedEnd = input.end_line ?? start + 199;
    const end = Math.min(Math.max(requestedEnd, start), start + 399, lines.length);
    return {
      repository: `${repository.owner}/${repository.repo}`,
      path: String(response.path ?? input.path),
      ref,
      sha: String(response.sha ?? ""),
      start_line: start,
      end_line: end,
      content: lines.slice(start - 1, end).join("\n"),
    };
  }

  private async listDirectory(repository: { owner: string; repo: string }, input: any) {
    const ref = input.ref ?? this.config.repository.defaultBranch;
    const path = input.path ?? "";
    const response = await this.reader.getContent(repository.owner, repository.repo, path, ref);
    if (!Array.isArray(response)) throw new Error(`Path is not a directory: ${path}`);
    return {
      repository: `${repository.owner}/${repository.repo}`,
      path,
      ref,
      entries: response.slice(0, 100).map((entry) => ({
        type: String(entry.type ?? ""),
        path: String(entry.path ?? entry.name ?? ""),
        sha: String(entry.sha ?? ""),
        size: Number(entry.size ?? 0),
      })),
    };
  }

  private async searchThreads(repository: { owner: string; repo: string }, input: any) {
    const qualifiers = [
      `repo:${repository.owner}/${repository.repo}`,
      input.kind === "issue" ? "is:issue" : input.kind === "pull_request" ? "is:pr" : "",
      input.state === "all" ? "" : `state:${input.state}`,
    ].filter(Boolean);
    const response = await this.reader.searchIssuesAndPulls(`${input.query} ${qualifiers.join(" ")}`);
    const matches = response.items
      .map((item) => this.candidateFromItem(item))
      .filter((candidate): candidate is CandidateContext => Boolean(candidate))
      .filter(
        (candidate) =>
          candidate.owner.toLowerCase() === repository.owner.toLowerCase() &&
          candidate.repo.toLowerCase() === repository.repo.toLowerCase() &&
          !(
            candidate.number === this.event.item.number &&
            candidate.owner.toLowerCase() === this.event.repository.owner.toLowerCase() &&
            candidate.repo.toLowerCase() === this.event.repository.repo.toLowerCase()
          ),
      )
      .slice(0, this.config.search.maxCandidates)
      .map((candidate) => ({
        candidate_index: this.registerCandidate(candidate),
        owner: candidate.owner,
        repo: candidate.repo,
        number: candidate.number,
        kind: candidate.kind,
        title: candidate.title,
        summary: candidate.summary,
        state: candidate.state,
      }));
    return { repository: `${repository.owner}/${repository.repo}`, matches };
  }

  private async inspectThread(repository: { owner: string; repo: string }, number: number) {
    const currentThread =
      number === this.event.item.number &&
      repository.owner.toLowerCase() === this.event.repository.owner.toLowerCase() &&
      repository.repo.toLowerCase() === this.event.repository.repo.toLowerCase();
    const issue = await this.reader.getIssue(repository.owner, repository.repo, number);
    const kind = issue.pull_request ? "pull_request" : "issue";
    const comments = await this.reader.listComments(repository.owner, repository.repo, number);
    const candidate: CandidateContext = {
      owner: repository.owner,
      repo: repository.repo,
      number,
      kind,
      title: String(issue.title ?? ""),
      summary: String(issue.body ?? "").slice(0, 1500),
      body: String(issue.body ?? ""),
      state: String(issue.state ?? "open"),
      contentHash: String(issue.updated_at ?? ""),
    };
    if (kind === "pull_request") {
      const [pull, files] = await Promise.all([
        this.reader.getPull(repository.owner, repository.repo, number),
        this.reader.listPullFiles(repository.owner, repository.repo, number),
      ]);
      candidate.body = String(pull.body ?? candidate.body ?? "");
      candidate.headSha = String(pull.head?.sha ?? "");
      candidate.baseBranch = String(pull.base?.ref ?? "");
      candidate.contentHash = String(pull.head?.sha ?? pull.updated_at ?? candidate.contentHash);
      candidate.files = files.map((file) => String(file.filename ?? ""));
      candidate.filePatches = files.slice(0, 30).map((file) => ({
        path: String(file.filename ?? ""),
        patch: file.patch ? String(file.patch).slice(0, 5000) : undefined,
      }));
      if (currentThread) {
        this.currentPullFiles = candidate.filePatches;
        for (let index = 0; index < this.candidateList.length; index += 1) {
          const existing = this.candidateList[index];
          if (existing?.kind !== "issue") continue;
          this.candidateList[index] = this.withCurrentPullEvidence(existing);
        }
      }
    }
    let cachedRelationship: RelationshipCandidate | null = null;
    if (!currentThread && this.relationshipCache) {
      const comparisonHash = await relationshipComparisonHash(this.event, candidate);
      cachedRelationship = await this.relationshipCache.cachedRelationship(
        this.event,
        candidate,
        comparisonHash,
      );
      if (cachedRelationship) {
        const key = `${candidate.owner.toLowerCase()}/${candidate.repo.toLowerCase()}#${candidate.number}`;
        this.reusedRelationships.set(key, cachedRelationship);
      }
    }
    return {
      ...(currentThread
        ? { current_thread: true }
        : { candidate_index: this.registerCandidate(candidate) }),
      repository: `${repository.owner}/${repository.repo}`,
      number,
      kind,
      title: candidate.title,
      body: candidate.body,
      state: candidate.state,
      base_branch: candidate.baseBranch,
      head_sha: candidate.headSha,
      comments: comments.slice(-30).map((comment) => ({
        author: String(comment.user?.login ?? ""),
        association: String(comment.author_association ?? ""),
        created_at: String(comment.created_at ?? ""),
        body: String(comment.body ?? "").slice(0, 4000),
      })),
      files: candidate.filePatches,
      cached_relationship: cachedRelationship
        ? {
            relationship: cachedRelationship.relationship,
            confidence: cachedRelationship.confidence,
            evidence: cachedRelationship.evidence,
          }
        : undefined,
    };
  }

  private async listCommits(
    repository: { owner: string; repo: string },
    path: string,
    limit: number,
  ) {
    const commits = await this.reader.listCommitsForPath(repository.owner, repository.repo, path, limit);
    return {
      repository: `${repository.owner}/${repository.repo}`,
      path,
      commits: commits.slice(0, limit).map((commit) => ({
        sha: String(commit.sha ?? ""),
        author: String(commit.author?.login ?? commit.commit?.author?.name ?? ""),
        date: String(commit.commit?.author?.date ?? ""),
        message: String(commit.commit?.message ?? "").split("\n")[0],
      })),
    };
  }

  private candidateFromItem(item: GitHubRecord): CandidateContext | null {
    const repository = repositoryFromUrl(String(item.repository_url ?? ""));
    if (!repository || !Number.isInteger(Number(item.number))) return null;
    return {
      ...repository,
      number: Number(item.number),
      kind: item.pull_request ? "pull_request" : "issue",
      title: String(item.title ?? ""),
      summary: String(item.body ?? "").slice(0, 1500),
      body: String(item.body ?? ""),
      state: String(item.state ?? "open"),
      contentHash: String(item.updated_at ?? ""),
    };
  }

  private registerCandidate(candidate: CandidateContext): number {
    candidate = this.withCurrentPullEvidence(candidate);
    const key = `${candidate.owner.toLowerCase()}/${candidate.repo.toLowerCase()}#${candidate.number}`;
    const existing = this.candidateIndexes.get(key);
    if (existing !== undefined) {
      this.candidateList[existing] = { ...this.candidateList[existing], ...candidate };
      return existing;
    }
    const index = this.candidateList.length;
    this.candidateIndexes.set(key, index);
    this.candidateList.push(candidate);
    return index;
  }

  private withCurrentPullEvidence(candidate: CandidateContext): CandidateContext {
    if (this.event.item.kind !== "pull_request" || candidate.kind !== "issue" || !this.currentPullFiles) {
      return candidate;
    }
    return {
      ...candidate,
      files: this.currentPullFiles.map((file) => file.path),
      filePatches: this.currentPullFiles,
    };
  }

  private boundResult(result: unknown): unknown {
    const serialized = JSON.stringify(result);
    if (serialized.length <= this.config.budgets.maxToolResultCharacters) return result;
    return {
      truncated: true,
      character_limit: this.config.budgets.maxToolResultCharacters,
      content: serialized.slice(0, this.config.budgets.maxToolResultCharacters),
    };
  }
}
