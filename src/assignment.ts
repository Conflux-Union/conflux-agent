import type { RepositoryConfig } from "./config";
import type { AgentDecision, EvidenceRef, ProposedAction, RepositoryEvent } from "./domain";
import type { GitHubClient } from "./github";
import { sha256 } from "./crypto";

interface CommitRecord {
  sha: string;
  login?: string;
  message?: string;
}

export interface CommitHistoryClient {
  listCommitsForPath(
    owner: string,
    repo: string,
    path: string,
    perPage: number,
  ): Promise<Array<Record<string, any>>>;
  canAssign(owner: string, repo: string, assignee: string): Promise<boolean>;
}

export function historyPath(pattern: string): string | null {
  const wildcard = pattern.search(/[?*\[]/);
  const stable = (wildcard === -1 ? pattern : pattern.slice(0, wildcard))
    .replace(/\/+$/, "")
    .trim();
  return stable || null;
}

export function selectDominantCommitter(
  commits: CommitRecord[],
  rules: RepositoryConfig["autonomy"]["assignment"],
): { login: string; count: number; total: number; runnerUp: number; commits: CommitRecord[] } | null {
  const unique = new Map(
    commits
      .filter((commit) => commit.sha && commit.login && !/\[bot\]$/i.test(commit.login))
      .map((commit) => [commit.sha, commit]),
  );
  const byLogin = new Map<string, CommitRecord[]>();
  for (const commit of unique.values()) {
    const list = byLogin.get(commit.login!) ?? [];
    list.push(commit);
    byLogin.set(commit.login!, list);
  }
  const ranked = [...byLogin.entries()].sort(
    (left, right) => right[1].length - left[1].length || left[0].localeCompare(right[0]),
  );
  const [winner, runnerUp] = ranked;
  if (!winner) return null;
  const total = unique.size;
  const count = winner[1].length;
  const runnerUpCount = runnerUp?.[1].length ?? 0;
  if (
    count < rules.minimumCommits ||
    count / total < rules.minimumShare ||
    count - runnerUpCount < rules.minimumLead
  ) {
    return null;
  }
  return { login: winner[0], count, total, runnerUp: runnerUpCount, commits: winner[1] };
}

export async function planCommitHistoryAssignment(
  event: RepositoryEvent,
  decision: AgentDecision,
  config: RepositoryConfig,
  github: CommitHistoryClient | GitHubClient,
): Promise<ProposedAction | null> {
  if (
    event.item.kind !== "issue" ||
    decision.requestScope === "off_topic" ||
    !config.autonomy.automatic.assignment ||
    event.item.assignees.length > 0 ||
    decision.relationships.some(
      (relationship) =>
        relationship.relationship === "duplicate" && relationship.kind === "issue",
    ) ||
    decision.classification.areaLabels.length === 0
  ) {
    return null;
  }
  const areas = config.areas.filter((area) =>
    decision.classification.areaLabels.includes(area.label),
  );
  const paths = [
    ...new Set(areas.flatMap((area) => area.paths.map(historyPath).filter(Boolean))),
  ] as string[];
  if (!paths.length) return null;

  const raw = await Promise.all(
    paths.map((path) =>
      github.listCommitsForPath(
        event.repository.owner,
        event.repository.repo,
        path,
        config.autonomy.assignment.historyDepth,
      ),
    ),
  );
  const commits = raw.flatMap((page) =>
    page.map((commit) => ({
      sha: String(commit.sha ?? ""),
      login: commit.author?.login ? String(commit.author.login) : undefined,
      message: commit.commit?.message ? String(commit.commit.message).split("\n")[0] : undefined,
    })),
  );
  const selected = selectDominantCommitter(commits, config.autonomy.assignment);
  if (!selected || event.item.assignees.includes(selected.login)) return null;
  if (!(await github.canAssign(event.repository.owner, event.repository.repo, selected.login))) {
    return null;
  }
  const areaLabels = areas.map((area) => area.label);
  const parameters = {
    assignees: [selected.login],
    areaLabels,
    source: "commit_history",
    dominantCommits: selected.count,
    totalCommits: selected.total,
    runnerUpCommits: selected.runnerUp,
  };
  const evidence: EvidenceRef[] = selected.commits.slice(0, 5).map((commit) => ({
    kind: "commit",
    reference: commit.sha,
    excerpt: commit.message,
  }));
  const actionId = (
    await sha256(
      JSON.stringify([
        event.repository.owner,
        event.repository.repo,
        event.item.number,
        event.item.updatedAt,
        "set_assignees",
        parameters,
      ]),
    )
  ).slice(0, 16);
  return {
    id: actionId,
    kind: "set_assignees",
    target: {
      owner: event.repository.owner,
      repo: event.repository.repo,
      number: event.item.number,
    },
    parameters,
    confidence: 1,
    evidence,
    rationale: `${selected.login} authored ${selected.count}/${selected.total} recent commits in ${areaLabels.join(", ")}`,
  };
}
