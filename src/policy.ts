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

function automaticEnabled(action: ProposedAction, config: RepositoryConfig): boolean {
  switch (action.kind) {
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
      if (action.parameters.reason === "duplicate") {
        return config.autonomy.automatic.duplicate;
      }
      return action.parameters.reason === "wontfix" && config.autonomy.automatic.wontfix;
    case "set_milestone":
      return config.autonomy.automatic.metadata;
  }
}

function isConcreteDuplicate(
  action: ProposedAction,
  event: RepositoryEvent,
): boolean {
  const relationship = action.parameters.relationship as RelationshipCandidate | undefined;
  const duplicateOf = action.parameters.duplicateOf;
  const expectedReference = `${event.repository.owner}/${event.repository.repo}#${duplicateOf}`;
  return Boolean(
    event.item.kind === "issue" &&
      duplicateOf !== event.item.number &&
      relationship?.relationship === "duplicate" &&
      relationship.kind === "issue" &&
      relationship.owner.toLowerCase() === event.repository.owner.toLowerCase() &&
      relationship.repo.toLowerCase() === event.repository.repo.toLowerCase() &&
      relationship.number === duplicateOf &&
      Number.isInteger(duplicateOf) &&
      relationship.evidence.some(
        (entry) =>
          entry.kind === "issue" &&
          entry.reference.toLowerCase() === expectedReference.toLowerCase() &&
          Boolean(entry.excerpt?.trim()),
      ),
  );
}

function isCommitHistoryAssignment(
  action: ProposedAction,
  config: RepositoryConfig,
): boolean {
  const assignees = action.parameters.assignees as string[] | undefined;
  const areaLabels = action.parameters.areaLabels as string[] | undefined;
  const dominantCommits = Number(action.parameters.dominantCommits);
  const totalCommits = Number(action.parameters.totalCommits);
  const runnerUpCommits = Number(action.parameters.runnerUpCommits);
  const configuredAreas = new Set(config.areas.map((area) => area.label));
  return Boolean(
    action.parameters.source === "commit_history" &&
      assignees?.length === 1 &&
      areaLabels?.length &&
      areaLabels.every((label) => configuredAreas.has(label)) &&
      Number.isInteger(dominantCommits) &&
      Number.isInteger(totalCommits) &&
      Number.isInteger(runnerUpCommits) &&
      totalCommits >= dominantCommits &&
      dominantCommits > runnerUpCommits &&
      runnerUpCommits >= 0 &&
      dominantCommits >= config.autonomy.assignment.minimumCommits &&
      dominantCommits / totalCommits >= config.autonomy.assignment.minimumShare &&
      dominantCommits - runnerUpCommits >= config.autonomy.assignment.minimumLead &&
      action.evidence.some(
        (entry) => entry.kind === "commit" && /^[0-9a-f]{7,40}$/i.test(entry.reference),
      ),
  );
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
      if (!isConcreteDuplicate(action, event)) {
        result.pending.push({ ...action, requiresApproval: true });
        continue;
      }
    }
    if (action.kind === "set_assignees") {
      if (!isCommitHistoryAssignment(action, config)) {
        result.rejected.push({
          action,
          reason: "Assignment must come from verified module commit history",
        });
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
    const minimumConfidence =
      action.kind === "close_issue" && action.parameters.reason === "duplicate"
        ? config.autonomy.duplicateMinimumConfidence
        : config.autonomy.minimumConfidence;
    const confident = action.confidence >= minimumConfidence;
    if (action.requiresApproval || !automaticEnabled(action, config) || (highImpact && !confident)) {
      result.pending.push({ ...action, requiresApproval: true });
      continue;
    }
    result.executable.push({ ...action, requiresApproval: false });
  }
  return result;
}

export function mayApprove(event: RepositoryEvent, config: RepositoryConfig): boolean {
  const association = event.comment?.authorAssociation ?? event.item.authorAssociation;
  return Boolean(association && config.autonomy.trustedAssociations.includes(association as never));
}
