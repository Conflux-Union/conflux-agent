import type { RepositoryConfig } from "./config";
import type {
  AgentDecision,
  Classification,
  ProposedAction,
  RelationshipCandidate,
  RepositoryEvent,
  ThreadState,
} from "./domain";
import { sha256 } from "./crypto";
import { offTopicReply } from "./scope";

function nativeFieldLabel(
  currentLabels: string[],
  value: string,
  mappings: Record<
    string,
    { label: string; fieldValue: string; canonical: boolean; titlePrefix?: string }
  >,
): string | undefined {
  const matches = Object.values(mappings).filter(
    (mapping) => mapping.fieldValue.toLowerCase() === value.toLowerCase(),
  );
  return (
    matches.find((mapping) => currentLabels.includes(mapping.label))?.label ??
    matches.find((mapping) => mapping.canonical)?.label ??
    matches[0]?.label
  );
}

async function id(event: RepositoryEvent, kind: string, value: unknown): Promise<string> {
  return (
    await sha256(
      JSON.stringify([
        event.repository.owner,
        event.repository.repo,
        event.item.number,
        event.item.updatedAt,
        kind,
        value,
      ]),
    )
  ).slice(0, 16);
}

function target(event: RepositoryEvent) {
  return {
    owner: event.repository.owner,
    repo: event.repository.repo,
    number: event.item.number,
  };
}

type ManualOverride = ThreadState["manualOverrides"][number];

export function metadataOverrideForEvent(
  event: RepositoryEvent,
  config: RepositoryConfig,
): ManualOverride | null {
  const base = {
    kind: "metadata" as const,
    actor: event.sender.login,
    at: event.item.updatedAt,
  };
  if (event.changedField) {
    const field = event.changedField.name.toLowerCase();
    const mappings =
      field === "priority" ? config.metadata.priorities : config.metadata.issueTypes;
    if (field !== "priority" && field !== "type") return null;
    const key = field === "priority" ? "priority" : "issueKind";
    const value = Object.entries(mappings).find(
      ([, mapping]) =>
        mapping.fieldValue.toLowerCase() === event.changedField?.value?.toLowerCase(),
    )?.[0];
    return { ...base, key, value: value ?? "" };
  }
  if (!event.changedLabel || (event.action !== "labeled" && event.action !== "unlabeled")) {
    return null;
  }
  const type = Object.entries(config.metadata.issueTypes).find(
    ([, mapping]) => mapping.label === event.changedLabel,
  );
  if (type) return { ...base, key: "issueKind", value: event.action === "labeled" ? type[0] : "" };
  const priority = Object.entries(config.metadata.priorities).find(
    ([, mapping]) => mapping.label === event.changedLabel,
  );
  if (priority) {
    return { ...base, key: "priority", value: event.action === "labeled" ? priority[0] : "" };
  }
  const area = config.areas.find((entry) => entry.label === event.changedLabel);
  return area
    ? { ...base, key: `area:${area.label}`, value: event.action === "labeled" ? area.label : "" }
    : null;
}

export function applyMetadataOverrides(
  classification: Classification,
  overrides: ManualOverride[],
): Classification {
  const latest = new Map(
    overrides.filter((override) => override.kind === "metadata").map((override) => [override.key, override]),
  );
  const issueKind = latest.has("issueKind") ? latest.get("issueKind")?.value || undefined : classification.issueKind;
  const priority = latest.has("priority") ? latest.get("priority")?.value || undefined : classification.priority;
  const areaLabels = new Set(classification.areaLabels);
  for (const [key, override] of latest) {
    if (!key.startsWith("area:")) continue;
    const label = key.slice("area:".length);
    if (override.value) areaLabels.add(label);
    else areaLabels.delete(label);
  }
  return { issueKind, priority, areaLabels: [...areaLabels] };
}

export async function planNativeMetadataMirror(
  event: RepositoryEvent,
  config: RepositoryConfig,
): Promise<ProposedAction[]> {
  if (event.item.kind !== "issue" || !event.changedField) return [];
  const fieldName = event.changedField.name.toLowerCase();
  const mappings =
    fieldName === "priority" ? config.metadata.priorities : config.metadata.issueTypes;
  if (fieldName !== "priority" && fieldName !== "type") return [];
  if (!event.changedField.value) {
    const managed = new Set(Object.values(mappings).map((mapping) => mapping.label));
    const remove = event.item.labels.filter((current) => managed.has(current));
    if (!remove.length) return [];
    return [
      {
        id: await id(event, "set_labels", { add: [], remove }),
        kind: "set_labels",
        target: target(event),
        parameters: { add: [], remove },
        confidence: 1,
        evidence: [],
        rationale: `Mirror cleared native ${event.changedField.name} to managed labels`,
      },
    ];
  }
  const label = nativeFieldLabel(event.item.labels, event.changedField.value, mappings);
  if (!label || event.item.labels.includes(label)) return [];
  const managed = new Set(Object.values(mappings).map((mapping) => mapping.label));
  const remove = event.item.labels.filter((current) => managed.has(current));
  return [
    {
      id: await id(event, "set_labels", { add: [label], remove }),
      kind: "set_labels",
      target: target(event),
      parameters: { add: [label], remove },
      confidence: 1,
      evidence: [],
      rationale: `Mirror native ${event.changedField.name} to its managed label`,
    },
  ];
}

export async function planLabelMetadataMirror(
  event: RepositoryEvent,
  config: RepositoryConfig,
): Promise<ProposedAction[]> {
  if (
    event.item.kind !== "issue" ||
    (event.action !== "labeled" && event.action !== "unlabeled") ||
    !event.changedLabel
  ) {
    return [];
  }
  const actions: ProposedAction[] = [];
  const changedType = Object.values(config.metadata.issueTypes).find(
    (mapping) => mapping.label === event.changedLabel,
  );
  const changedPriority = Object.values(config.metadata.priorities).find(
    (mapping) => mapping.label === event.changedLabel,
  );
  const typeMatches = Object.entries(config.metadata.issueTypes).filter(([, mapping]) =>
    event.item.labels.includes(mapping.label),
  );
  if (changedType && event.action === "labeled") {
    const remove = typeMatches
      .map(([, mapping]) => mapping.label)
      .filter((label) => label !== changedType.label);
    if (remove.length) {
      actions.push({
        id: await id(event, "set_labels", { add: [], remove }),
        kind: "set_labels",
        target: target(event),
        parameters: { add: [], remove },
        confidence: 1,
        evidence: [],
        rationale: "Keep only the latest human-selected managed type label",
      });
    }
    actions.push({
      id: await id(event, "set_issue_type", changedType.fieldValue),
      kind: "set_issue_type",
      target: target(event),
      parameters: { value: changedType.fieldValue },
      confidence: 1,
      evidence: [],
      rationale: "Mirror the managed type label to the native issue type",
    });
  } else if (changedType && typeMatches.length === 1) {
    const mapping = typeMatches[0]?.[1];
    if (mapping) {
      actions.push({
        id: await id(event, "set_issue_type", mapping.fieldValue),
        kind: "set_issue_type",
        target: target(event),
        parameters: { value: mapping.fieldValue },
        confidence: 1,
        evidence: [],
        rationale: "Mirror the managed type label to the native issue type",
      });
    }
  } else if (changedType && typeMatches.length === 0) {
    actions.push({
      id: await id(event, "clear_issue_type", event.action),
      kind: "clear_issue_type",
      target: target(event),
      parameters: {},
      confidence: 1,
      evidence: [],
      rationale: "Clear the native issue type after its final managed label was removed",
    });
  }
  const priorityMatches = Object.entries(config.metadata.priorities).filter(([, mapping]) =>
    event.item.labels.includes(mapping.label),
  );
  if (changedPriority && event.action === "labeled" && config.metadata.priorityFieldId) {
    const remove = priorityMatches
      .map(([, mapping]) => mapping.label)
      .filter((label) => label !== changedPriority.label);
    if (remove.length) {
      actions.push({
        id: await id(event, "set_labels", { add: [], remove }),
        kind: "set_labels",
        target: target(event),
        parameters: { add: [], remove },
        confidence: 1,
        evidence: [],
        rationale: "Keep only the latest human-selected managed priority label",
      });
    }
    actions.push({
      id: await id(event, "set_issue_field", changedPriority.fieldValue),
      kind: "set_issue_field",
      target: target(event),
      parameters: {
        fieldId: config.metadata.priorityFieldId,
        value: changedPriority.fieldValue,
      },
      confidence: 1,
      evidence: [],
      rationale: "Mirror the managed priority label to the native priority field",
    });
  } else if (changedPriority && priorityMatches.length === 1 && config.metadata.priorityFieldId) {
    const mapping = priorityMatches[0]?.[1];
    if (mapping) {
      actions.push({
        id: await id(event, "set_issue_field", mapping.fieldValue),
        kind: "set_issue_field",
        target: target(event),
        parameters: {
          fieldId: config.metadata.priorityFieldId,
          value: mapping.fieldValue,
        },
        confidence: 1,
        evidence: [],
        rationale: "Mirror the managed priority label to the native priority field",
      });
    }
  } else if (
    changedPriority &&
    priorityMatches.length === 0 &&
    config.metadata.priorityFieldId
  ) {
    actions.push({
      id: await id(event, "clear_issue_field", config.metadata.priorityFieldId),
      kind: "clear_issue_field",
      target: target(event),
      parameters: { fieldId: config.metadata.priorityFieldId },
      confidence: 1,
      evidence: [],
      rationale: "Clear the native priority after its final managed label was removed",
    });
  }
  return actions;
}

function metadataLabels(decision: AgentDecision, config: RepositoryConfig): string[] {
  const labels = [...decision.classification.areaLabels];
  if (decision.classification.issueKind) {
    const mapping = config.metadata.issueTypes[decision.classification.issueKind];
    if (mapping) labels.push(mapping.label);
  }
  if (decision.classification.priority) {
    const mapping = config.metadata.priorities[decision.classification.priority];
    if (mapping) labels.push(mapping.label);
  }
  return [...new Set(labels)];
}

function relationshipForClosing(
  event: RepositoryEvent,
  relationship: RelationshipCandidate,
): {
  issueNumber: number;
  pullNumber: number;
  baseBranch?: string;
  relationship: RelationshipCandidate;
} | null {
  if (relationship.relationship !== "resolves") return null;
  if (event.item.kind === "pull_request" && relationship.kind === "issue") {
    return {
      issueNumber: relationship.number,
      pullNumber: event.item.number,
      baseBranch: event.item.baseBranch,
      relationship,
    };
  }
  if (event.item.kind === "issue" && relationship.kind === "pull_request") {
    return {
      issueNumber: event.item.number,
      pullNumber: relationship.number,
      baseBranch: relationship.evidence.find((entry) => entry.kind === "pull_request")
        ?.excerpt,
      relationship,
    };
  }
  return null;
}

export async function planActions(
  event: RepositoryEvent,
  state: ThreadState,
  decision: AgentDecision,
  config: RepositoryConfig,
): Promise<ProposedAction[]> {
  if (decision.requestScope === "off_topic") {
    const body = offTopicReply(event.comment?.body ?? event.item.body);
    return [
      {
        id: await id(event, "comment", body),
        kind: "comment",
        target: target(event),
        parameters: { body },
        confidence: 1,
        evidence: [],
        rationale: "Decline a request outside repository maintenance scope",
      },
    ];
  }
  const actions = [...decision.actions];
  if (decision.reply && decision.disposition !== "wait") {
    actions.push({
      id: await id(event, "comment", decision.reply),
      kind: "comment",
      target: target(event),
      parameters: { body: decision.reply },
      confidence: 1,
      evidence: [],
      rationale: "Continue the repository conversation",
    });
  }
  if (decision.normalizedTitle && decision.normalizedTitle !== event.item.title) {
    const prefix = decision.classification.issueKind
      ? config.metadata.issueTypes[decision.classification.issueKind]?.titlePrefix
      : undefined;
    const title = prefix
      ? `${prefix} ${decision.normalizedTitle.replace(/^\[[^\]]+\]\s*/, "")}`
      : decision.normalizedTitle;
    actions.push({
      id: await id(event, "set_title", title),
      kind: "set_title",
      target: target(event),
      parameters: { title },
      confidence: 0.95,
      evidence: [],
      rationale: "Normalize the title without changing confirmed meaning",
    });
  }

  const desiredLabels = metadataLabels(decision, config);
  const remove: string[] = [];
  const add = desiredLabels.filter((label) => !event.item.labels.includes(label));
  if (add.length || remove.length) {
    actions.push({
      id: await id(event, "set_labels", { add, remove }),
      kind: "set_labels",
      target: target(event),
      parameters: { add, remove },
      confidence: 0.95,
      evidence: [],
      rationale: "Synchronize managed classification labels",
    });
  }

  if (event.item.kind === "issue" && decision.classification.issueKind) {
    const mapping = config.metadata.issueTypes[decision.classification.issueKind];
    if (mapping) {
      actions.push({
        id: await id(event, "set_issue_type", mapping.fieldValue),
        kind: "set_issue_type",
        target: target(event),
        parameters: { value: mapping.fieldValue },
        confidence: 0.95,
        evidence: [],
        rationale: "Synchronize the native issue type with its label",
      });
    }
  }
  if (
    event.item.kind === "issue" &&
    decision.classification.priority &&
    config.metadata.priorityFieldId
  ) {
    const mapping = config.metadata.priorities[decision.classification.priority];
    if (mapping) {
      actions.push({
        id: await id(event, "set_issue_field", mapping.fieldValue),
        kind: "set_issue_field",
        target: target(event),
        parameters: {
          fieldId: config.metadata.priorityFieldId,
          value: mapping.fieldValue,
        },
        confidence: 0.95,
        evidence: [],
        rationale: "Synchronize the native priority field with its label",
      });
    }
  }
  if (event.item.kind === "issue" && config.metadata.projectId) {
    actions.push({
      id: await id(event, "add_to_project", config.metadata.projectId),
      kind: "add_to_project",
      target: target(event),
      parameters: { projectId: config.metadata.projectId },
      confidence: 1,
      evidence: [],
      rationale: "Add the issue to the configured repository project",
    });
  }

  for (const relationship of decision.relationships) {
    const closing = relationshipForClosing(event, relationship);
    if (!closing) continue;
    const pullTarget =
      event.item.kind === "pull_request"
        ? target(event)
        : {
            owner: relationship.owner,
            repo: relationship.repo,
            number: closing.pullNumber,
          };
    actions.push({
      id: await id(event, "link_closing_issue", closing.issueNumber),
      kind: "link_closing_issue",
      target: pullTarget,
      parameters: {
        issueNumber: closing.issueNumber,
        relationship: closing.relationship,
        baseBranch: closing.baseBranch,
      },
      confidence: relationship.confidence,
      evidence: relationship.evidence,
      rationale: `Pull request resolves issue #${closing.issueNumber}`,
    });
  }
  if (event.item.kind === "issue") {
    const relationship = decision.relationships
      .filter(
        (candidate) =>
          candidate.relationship === "duplicate" && candidate.kind === "issue",
      )
      .sort((left, right) => right.confidence - left.confidence)[0];
    if (relationship) {
      actions.push({
        id: await id(event, "close_issue", {
          reason: "duplicate",
          duplicateOf: relationship.number,
        }),
        kind: "close_issue",
        target: target(event),
        parameters: {
          reason: "duplicate",
          duplicateOf: relationship.number,
          relationship,
        },
        confidence: relationship.confidence,
        evidence: relationship.evidence,
        rationale: `Duplicate of #${relationship.number}`,
      });
    }
  }

  return actions.filter(
    (action, index, all) =>
      all.findIndex(
        (candidate) => candidate.kind === action.kind && candidate.id === action.id,
      ) === index && !state.manualOverrides.some((override) => override.key === action.id),
  );
}
