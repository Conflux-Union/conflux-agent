import type { RepositoryEvent } from "./domain";

type JsonObject = Record<string, any>;

const SUPPORTED_EVENTS = new Set([
  "issues",
  "issue_comment",
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
]);

export function parseWebhook(eventName: string, deliveryId: string, payload: JsonObject): RepositoryEvent | null {
  if (!SUPPORTED_EVENTS.has(eventName)) return null;
  const repository = payload.repository;
  const installationId = payload.installation?.id;
  if (!repository || typeof installationId !== "number") return null;

  const rawItem = payload.pull_request ?? payload.issue;
  if (!rawItem || typeof rawItem.number !== "number") return null;
  const kind = payload.pull_request || rawItem.pull_request ? "pull_request" : "issue";
  const comment = payload.comment ?? payload.review;
  const field = payload.issue_field ?? payload.field;
  const fieldValue = payload.issue_field_value ?? payload.value;
  const previousFieldValue =
    payload.changes?.issue_field_value?.from ?? payload.changes?.field_value?.from;
  const changedField =
    payload.action === "typed" || payload.action === "untyped"
      ? {
          name: "Type",
          value: payload.action === "typed" ? payload.type?.name : undefined,
        }
      : field
        ? {
            name: String(field.name ?? ""),
            value:
              fieldValue?.single_select_option?.name ??
              fieldValue?.name ??
              fieldValue?.value ??
              undefined,
            previousValue:
              previousFieldValue?.single_select_option?.name ??
              previousFieldValue?.name ??
              previousFieldValue?.value ??
              undefined,
          }
        : undefined;

  return {
    deliveryId,
    eventName,
    action: String(payload.action ?? "unknown"),
    repository: {
      installationId,
      owner: String(repository.owner.login),
      repo: String(repository.name),
      defaultBranch: String(repository.default_branch),
    },
    item: {
      kind,
      number: Number(rawItem.number),
      nodeId: rawItem.node_id ? String(rawItem.node_id) : undefined,
      title: String(rawItem.title ?? ""),
      body: String(rawItem.body ?? ""),
      state: rawItem.state === "closed" ? "closed" : "open",
      author: String(rawItem.user?.login ?? "unknown"),
      authorAssociation: rawItem.author_association
        ? String(rawItem.author_association)
        : undefined,
      assignees: Array.isArray(rawItem.assignees)
        ? rawItem.assignees.map((assignee: JsonObject) => String(assignee.login))
        : [],
      labels: Array.isArray(rawItem.labels)
        ? rawItem.labels.map((label: JsonObject) => String(label.name))
        : [],
      nativeIssueType: rawItem.type?.name ? String(rawItem.type.name) : undefined,
      updatedAt: String(rawItem.updated_at ?? new Date().toISOString()),
      headSha: payload.pull_request?.head?.sha
        ? String(payload.pull_request.head.sha)
        : undefined,
      baseBranch: payload.pull_request?.base?.ref
        ? String(payload.pull_request.base.ref)
        : undefined,
    },
    sender: {
      login: String(payload.sender?.login ?? "unknown"),
      type: String(payload.sender?.type ?? "User"),
    },
    comment: comment
      ? {
          id: Number(comment.id),
          body: String(comment.body ?? ""),
          author: String(comment.user?.login ?? "unknown"),
          authorAssociation: comment.author_association
            ? String(comment.author_association)
            : undefined,
          updatedAt: String(comment.updated_at ?? new Date().toISOString()),
        }
      : undefined,
    changedField,
    changedLabel: payload.label?.name ? String(payload.label.name) : undefined,
  };
}

export function shouldIgnoreEvent(event: RepositoryEvent): boolean {
  if (/^(?:conflux-agent|github-actions)\[bot\]$/i.test(event.sender.login)) return true;
  if (event.eventName.includes("comment") && event.sender.type === "Bot") return true;
  if (event.item.state === "closed" && event.action !== "reopened") return true;
  return false;
}

export function threadName(event: RepositoryEvent): string {
  return [
    event.repository.installationId,
    event.repository.owner.toLowerCase(),
    event.repository.repo.toLowerCase(),
    event.item.kind,
    event.item.number,
  ].join(":");
}
