import { SignJWT, importPKCS8 } from "jose";
import { parse as parseYaml } from "yaml";
import { repositoryConfigSchema, type RepositoryConfig } from "./config";
import type { ProposedAction, RepositoryEvent } from "./domain";
import type { Env } from "./env";
import { readClosingLinks, updateClosingLinks } from "./managed-body";

interface GitHubErrorBody {
  message?: string;
  documentation_url?: string;
}

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function encodeLength(length: number): number[] {
  if (length < 0x80) return [length];
  const bytes: number[] = [];
  for (let value = length; value > 0; value >>>= 8) bytes.unshift(value & 0xff);
  return [0x80 | bytes.length, ...bytes];
}

function pemToDer(pem: string): Uint8Array {
  const base64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const binary = atob(base64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function derToPem(label: string, der: Uint8Array): string {
  let binary = "";
  for (const byte of der) binary += String.fromCharCode(byte);
  const base64 = btoa(binary).match(/.{1,64}/g)?.join("\n") ?? "";
  return `-----BEGIN ${label}-----\n${base64}\n-----END ${label}-----`;
}

export function normalizeGitHubPrivateKey(value: string): string {
  const pem = value.trim().replaceAll("\\n", "\n");
  if (pem.includes("-----BEGIN PRIVATE KEY-----")) return pem;
  if (!pem.includes("-----BEGIN RSA PRIVATE KEY-----")) {
    throw new Error("GitHub private key must be PKCS#1 or PKCS#8 PEM");
  }
  const rsaKey = pemToDer(pem);
  const version = [0x02, 0x01, 0x00];
  const rsaEncryption = [
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01,
    0x05, 0x00,
  ];
  const privateKey = [0x04, ...encodeLength(rsaKey.length), ...rsaKey];
  const body = Uint8Array.from([...version, ...rsaEncryption, ...privateKey]);
  const pkcs8 = Uint8Array.from([0x30, ...encodeLength(body.length), ...body]);
  return derToPem("PRIVATE KEY", pkcs8);
}

export function importGitHubPrivateKey(value: string) {
  return importPKCS8(normalizeGitHubPrivateKey(value), "RS256");
}

export class GitHubClient {
  private constructor(
    private readonly env: Env,
    private readonly token: string,
  ) {}

  static async forInstallation(env: Env, installationId: number): Promise<GitHubClient> {
    const privateKey = await importGitHubPrivateKey(env.GITHUB_PRIVATE_KEY);
    const now = Math.floor(Date.now() / 1000);
    const jwt = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256" })
      .setIssuedAt(now - 60)
      .setExpirationTime(now + 9 * 60)
      .setIssuer(env.GITHUB_APP_ID)
      .sign(privateKey);
    const response = await fetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
      method: "POST",
      headers: GitHubClient.headers(env, jwt),
    });
    if (!response.ok) throw await GitHubClient.error(response);
    const payload = (await response.json()) as { token: string };
    return new GitHubClient(env, payload.token);
  }

  private static headers(env: Env, token: string): HeadersInit {
    return {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "Conflux-Agent",
      "X-GitHub-Api-Version": env.GITHUB_API_VERSION,
    };
  }

  private static async error(response: Response): Promise<GitHubError> {
    const body = (await response.json().catch(() => ({}))) as GitHubErrorBody;
    return new GitHubError(body.message ?? `GitHub API returned ${response.status}`, response.status);
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(GitHubClient.headers(this.env, this.token));
    new Headers(init.headers).forEach((value, name) => headers.set(name, value));
    if (init.body) headers.set("Content-Type", "application/json");
    const response = await fetch(path.startsWith("https://") ? path : `https://api.github.com${path}`, {
      ...init,
      headers,
    });
    if (!response.ok) throw await GitHubClient.error(response);
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const response = await this.request<{ data?: T; errors?: Array<{ message: string }> }>("/graphql", {
      method: "POST",
      body: JSON.stringify({ query, variables }),
    });
    if (response.errors?.length) throw new Error(response.errors.map((error) => error.message).join("; "));
    if (!response.data) throw new Error("GitHub GraphQL returned no data");
    return response.data;
  }

  async loadConfig(owner: string, repo: string): Promise<RepositoryConfig | null> {
    try {
      const file = await this.request<{ content: string; encoding: string }>(
        `/repos/${owner}/${repo}/contents/.github/maintainer-agent.yml`,
      );
      const text = file.encoding === "base64" ? atob(file.content.replace(/\n/g, "")) : file.content;
      return repositoryConfigSchema.parse(parseYaml(text));
    } catch (error) {
      if (error instanceof GitHubError && error.status === 404) return null;
      throw error;
    }
  }

  getIssue(owner: string, repo: string, number: number) {
    return this.request<Record<string, any>>(`/repos/${owner}/${repo}/issues/${number}`);
  }

  getPull(owner: string, repo: string, number: number) {
    return this.request<Record<string, any>>(`/repos/${owner}/${repo}/pulls/${number}`);
  }

  listComments(owner: string, repo: string, number: number, since?: string) {
    const query = since ? `?per_page=100&since=${encodeURIComponent(since)}` : "?per_page=100";
    return this.request<Array<Record<string, any>>>(`/repos/${owner}/${repo}/issues/${number}/comments${query}`);
  }

  listPullFiles(owner: string, repo: string, number: number) {
    return this.request<Array<Record<string, any>>>(`/repos/${owner}/${repo}/pulls/${number}/files?per_page=100`);
  }

  listCommitsForPath(owner: string, repo: string, path: string, perPage: number) {
    return this.request<Array<Record<string, any>>>(
      `/repos/${owner}/${repo}/commits?path=${encodeURIComponent(path)}&per_page=${perPage}`,
    );
  }

  searchCode(owner: string, repo: string, query: string, path?: string) {
    const scope = [`repo:${owner}/${repo}`, path ? `path:${path}` : ""].filter(Boolean).join(" ");
    return this.request<Record<string, any>>(
      `/search/code?q=${encodeURIComponent(`${query} ${scope}`)}&per_page=20`,
      { headers: { Accept: "application/vnd.github.text-match+json" } },
    );
  }

  getContent(owner: string, repo: string, path: string, ref?: string) {
    const suffix = ref ? `?ref=${encodeURIComponent(ref)}` : "";
    const encodedPath = path ? `/${path.split("/").map(encodeURIComponent).join("/")}` : "";
    return this.request<Record<string, any> | Array<Record<string, any>>>(
      `/repos/${owner}/${repo}/contents${encodedPath}${suffix}`,
    );
  }

  async canAssign(owner: string, repo: string, assignee: string): Promise<boolean> {
    try {
      await this.request(`/repos/${owner}/${repo}/assignees/${encodeURIComponent(assignee)}`);
      return true;
    } catch (error) {
      if (error instanceof GitHubError && error.status === 404) return false;
      throw error;
    }
  }

  listIssueFieldValues(owner: string, repo: string, number: number) {
    return this.request<Array<Record<string, any>>>(
      `/repos/${owner}/${repo}/issues/${number}/issue-field-values`,
    );
  }

  searchIssuesAndPulls(query: string) {
    return this.request<{
      items: Array<Record<string, any>>;
    }>(`/search/issues?q=${encodeURIComponent(query)}&per_page=20`);
  }

  async listIssueTypes(owner: string, repo: string) {
    return this.request<Array<{ id: number; node_id: string; name: string }>>(
      `/repos/${owner}/${repo}/issue-types`,
    );
  }

  async addEyesReaction(owner: string, repo: string, number: number): Promise<void> {
    await this.request(`/repos/${owner}/${repo}/issues/${number}/reactions`, {
      method: "POST",
      body: JSON.stringify({ content: "eyes" }),
    });
  }

  async addManagedComment(
    owner: string,
    repo: string,
    number: number,
    body: string,
    markerId: string,
  ): Promise<void> {
    const trimmed = body.trim();
    if (!trimmed) return;
    const marker = `<!-- conflux-agent:${markerId} -->`;
    const existing = await this.listComments(owner, repo, number);
    if (existing.some((comment) => String(comment.body ?? "").includes(marker))) return;
    await this.request(`/repos/${owner}/${repo}/issues/${number}/comments`, {
      method: "POST",
      body: JSON.stringify({ body: `${trimmed}\n\n${marker}` }),
    });
  }

  async execute(action: ProposedAction, event: RepositoryEvent, config: RepositoryConfig): Promise<void> {
    const { owner, repo, number } = action.target;
    switch (action.kind) {
      case "comment": {
        await this.addManagedComment(
          owner,
          repo,
          number,
          String(action.parameters.body ?? ""),
          action.id,
        );
        return;
      }
      case "set_title":
        await this.patchIssue(owner, repo, number, { title: String(action.parameters.title) });
        return;
      case "set_labels": {
        const allowed = new Set([
          ...Object.values(config.metadata.issueTypes).map((entry) => entry.label),
          ...Object.values(config.metadata.priorities).map((entry) => entry.label),
          ...config.areas.map((entry) => entry.label),
          "status/needs info",
          "status/needs triage",
        ]);
        const live = await this.getIssue(owner, repo, number);
        const current = new Set(
          Array.isArray(live.labels)
            ? live.labels.map((label: Record<string, unknown>) => String(label.name))
            : [],
        );
        for (const label of (action.parameters.remove as string[] | undefined) ?? []) {
          if (allowed.has(label)) current.delete(label);
        }
        for (const label of (action.parameters.add as string[] | undefined) ?? []) {
          if (allowed.has(label)) current.add(label);
        }
        await this.patchIssue(owner, repo, number, { labels: [...current] });
        return;
      }
      case "set_issue_type": {
        if (event.item.kind !== "issue" || !event.item.nodeId) return;
        const value = String(action.parameters.value);
        const configured = Object.values(config.metadata.issueTypes).find(
          (mapping) => mapping.fieldValue.toLowerCase() === value.toLowerCase(),
        );
        if (!configured) throw new Error(`Issue type is not configured: ${value}`);
        const types = await this.listIssueTypes(owner, repo);
        const type = types.find((entry) => entry.name.toLowerCase() === configured.fieldValue.toLowerCase());
        if (!type) throw new Error(`Issue type does not exist: ${configured.fieldValue}`);
        await this.graphql(
          "mutation($id: ID!, $type: ID!) { updateIssue(input: {id: $id, issueTypeId: $type}) { issue { id } } }",
          { id: event.item.nodeId, type: type.node_id },
        );
        return;
      }
      case "clear_issue_type": {
        if (event.item.kind !== "issue" || !event.item.nodeId) return;
        await this.graphql(
          "mutation($id: ID!) { updateIssue(input: {id: $id, issueTypeId: null}) { issue { id } } }",
          { id: event.item.nodeId },
        );
        return;
      }
      case "set_issue_field": {
        if (event.item.kind !== "issue") return;
        const fieldId = Number(action.parameters.fieldId);
        const value = action.parameters.value as string | number;
        if (fieldId !== config.metadata.priorityFieldId) throw new Error("Issue field is not configured");
        const allowed = Object.values(config.metadata.priorities).some(
          (mapping) => mapping.fieldValue === value,
        );
        if (!allowed) throw new Error(`Issue field value is not configured: ${String(value)}`);
        await this.request(`/repos/${owner}/${repo}/issues/${number}/issue-field-values`, {
          method: "POST",
          body: JSON.stringify({ issue_field_values: [{ field_id: fieldId, value }] }),
        });
        return;
      }
      case "clear_issue_field": {
        if (event.item.kind !== "issue") return;
        const fieldId = Number(action.parameters.fieldId);
        if (fieldId !== config.metadata.priorityFieldId) {
          throw new Error("Issue field is not configured");
        }
        try {
          await this.request(
            `/repos/${owner}/${repo}/issues/${number}/issue-field-values/${fieldId}`,
            { method: "DELETE" },
          );
        } catch (error) {
          if (!(error instanceof GitHubError && error.status === 404)) throw error;
        }
        return;
      }
      case "set_milestone": {
        const title = String(action.parameters.title);
        const milestones = await this.request<Array<{ number: number; title: string }>>(
          `/repos/${owner}/${repo}/milestones?state=open&per_page=100`,
        );
        const milestone = milestones.find((entry) => entry.title === title);
        if (!milestone) throw new Error(`Milestone does not exist: ${title}`);
        await this.patchIssue(owner, repo, number, { milestone: milestone.number });
        return;
      }
      case "set_assignees": {
        const requested = (action.parameters.assignees as string[] | undefined) ?? [];
        if (action.parameters.source !== "commit_history" || requested.length !== 1) {
          throw new Error("Assignment requires one commit-history owner");
        }
        const assignees = requested;
        if (!(await this.canAssign(owner, repo, assignees[0]!))) {
          throw new Error(`GitHub user is not assignable: ${assignees[0]}`);
        }
        await this.request(`/repos/${owner}/${repo}/issues/${number}/assignees`, {
          method: "POST",
          body: JSON.stringify({ assignees }),
        });
        return;
      }
      case "add_to_project": {
        if (!config.metadata.projectId || !event.item.nodeId) return;
        await this.graphql(
          "mutation($project: ID!, $content: ID!) { addProjectV2ItemById(input: {projectId: $project, contentId: $content}) { item { id } } }",
          { project: config.metadata.projectId, content: event.item.nodeId },
        );
        return;
      }
      case "link_closing_issue": {
        const pull = await this.getPull(owner, repo, number);
        const issueNumber = Number(action.parameters.issueNumber);
        const links = readClosingLinks(String(pull.body ?? ""));
        const body = updateClosingLinks(String(pull.body ?? ""), [...links, issueNumber]);
        if (body !== pull.body) {
          await this.request(`/repos/${owner}/${repo}/pulls/${number}`, {
            method: "PATCH",
            body: JSON.stringify({ body }),
          });
        }
        return;
      }
      case "close_issue": {
        if (action.parameters.reason === "duplicate") {
          const duplicateOf = Number(action.parameters.duplicateOf);
          const canonicalIssue = await this.getIssue(owner, repo, duplicateOf);
          const duplicateIssueId = Number(canonicalIssue.id);
          if (!Number.isSafeInteger(duplicateIssueId) || duplicateIssueId <= 0) {
            throw new Error("The canonical issue has no valid database ID");
          }
          await this.patchIssue(owner, repo, number, {
            state: "closed",
            state_reason: "duplicate",
            duplicate_issue_id: duplicateIssueId,
          });
          return;
        }
        const reason = "not_planned";
        await this.patchIssue(owner, repo, number, { state: "closed", state_reason: reason });
        return;
      }
    }
  }

  private patchIssue(owner: string, repo: string, number: number, body: Record<string, unknown>) {
    return this.request(`/repos/${owner}/${repo}/issues/${number}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
  }
}
