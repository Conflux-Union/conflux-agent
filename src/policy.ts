import type {
  ActionKind,
  ProposedAction,
  RelationshipCandidate,
  RepositoryEvent,
} from "./domain";
import type { RepositoryConfig } from "./config";

const HIGH_IMPACT_ACTIONS = new Set<ActionKind>([
  "close_issue",
  "set_assignees",
  "set_milestone",
  "link_closing_issue",
]);

export interface PolicyResult {
  executable: ProposedAction[];
  pending: ProposedAction[];
  rejected: Array<{ action: ProposedAction; reason: string }>;
}

function automaticEnabled(kind: ActionKind, config: RepositoryConfig): boolean {
  switch (kind) {
    case "comment":
      return config.autonomy.automatic.conversation;
    case "set_title":
    case "set_labels":
    case "set_issue_type":
    case "clear_issue_type":
    case "set_issue_field":
    case "clear_issue_field":
    case "add_to_project":
      return config.autonomy.automatic.metadata;
    case "link_closing_issue":
      return config.autonomy.automatic.closingLinks;
    case "set_assignees":
      return config.autonomy.automatic.assignment;
    case "close_issue":
      return config.autonomy.automatic.duplicate || config.autonomy.automatic.wontfix;
    case "set_milestone":
      return config.autonomy.automatic.metadata;
  }
}

export function hasDeterministicResolutionEvidence(
  relationship: RelationshipCandidate,
): boolean {
  if (relationship.relationship !== "resolves") return false;
  const kinds = new Set(relationship.evidence.map((entry) => entry.kind));
  return (
    kinds.has("file") &&
    (kinds.has("test") || kinds.has("commit")) &&
    relationship.evidence.some((entry) => entry.excerpt?.trim())
  );
}

export function evaluateActions(
  actions: ProposedAction[],
  event: RepositoryEvent,
  config: RepositoryConfig,
): PolicyResult {
  const result: PolicyResult = { executable: [], pending: [], rejected: [] };
  const disabled = event.item.labels.some((label) => config.disabledLabels.includes(label));

  for (const action of actions) {
    if (disabled) {
      result.rejected.push({ action, reason: "Agent is disabled for this item" });
      continue;
    }
    if (
      action.target.owner !== event.repository.owner ||
      action.target.repo !== event.repository.repo
    ) {
      result.rejected.push({ action, reason: "Cross-repository writes are not allowed" });
      continue;
    }
    if (action.kind === "close_issue" && action.parameters.reason === "resolved") {
      result.rejected.push({
        action,
        reason: "Resolved issues must be closed by a merged pull request closing link",
      });
      continue;
    }
    if (action.kind === "close_issue" && action.parameters.reason === "duplicate") {
      const relationship = action.parameters.relationship as RelationshipCandidate | undefined;
      const hasIssueEvidence = relationship?.evidence.some(
        (entry) => entry.kind === "issue" && entry.excerpt?.trim(),
      );
      if (
        relationship?.relationship !== "duplicate" ||
        !hasIssueEvidence ||
        !Number.isInteger(action.parameters.duplicateOf)
      ) {
        result.pending.push({ ...action, requiresApproval: true });
        continue;
      }
    }
    if (action.kind === "set_assignees") {
      const assignees = action.parameters.assignees as string[] | undefined;
      const fileEvidence = action.evidence.filter((entry) => entry.kind === "file");
      const uniquelyConfigured = config.areas.some(
        (area) =>
          area.assignees.length === 1 &&
          assignees?.length === 1 &&
          area.assignees[0] === assignees[0] &&
          fileEvidence.some((entry) => area.paths.some((path) => pathMatches(path, entry.reference))),
      );
      if (!uniquelyConfigured) {
        result.pending.push({ ...action, requiresApproval: true });
        continue;
      }
    }
    if (action.kind === "set_milestone" && !action.evidence.some((entry) => entry.kind === "commit")) {
      result.pending.push({ ...action, requiresApproval: true });
      continue;
    }
    if (action.kind === "link_closing_issue") {
      const relationship = action.parameters.relationship as RelationshipCandidate | undefined;
      const targetsDefaultBranch = action.parameters.baseBranch === event.repository.defaultBranch;
      if (!relationship || !targetsDefaultBranch || !hasDeterministicResolutionEvidence(relationship)) {
        result.pending.push({ ...action, requiresApproval: true });
        continue;
      }
    }

    const highImpact = HIGH_IMPACT_ACTIONS.has(action.kind);
    const confident = action.confidence >= config.autonomy.minimumConfidence;
    if (action.requiresApproval || !automaticEnabled(action.kind, config) || (highImpact && !confident)) {
      result.pending.push({ ...action, requiresApproval: true });
      continue;
    }
    result.executable.push({ ...action, requiresApproval: false });
  }
  return result;
}

function pathMatches(pattern: string, path: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replaceAll("**", "\0")
    .replaceAll("*", "[^/]*")
    .replaceAll("\0", ".*");
  return new RegExp(`^${escaped}$`).test(path);
}

export function mayApprove(event: RepositoryEvent, config: RepositoryConfig): boolean {
  const association = event.comment?.authorAssociation ?? event.item.authorAssociation;
  return Boolean(association && config.autonomy.trustedAssociations.includes(association as never));
}
