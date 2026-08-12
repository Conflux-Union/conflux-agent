import type { ProposedAction, RepositoryEvent } from "./domain";

export const EVENT_PROCESSING_ATTEMPTS = 3;

export function deliveryFailureStatus(error: unknown): string {
  const name = error instanceof Error ? error.name : "Error";
  const message = error instanceof Error ? error.message : String(error);
  const sanitized = `${name}: ${message}`
    .replace(/sk-[A-Za-z0-9_-]{16,}/g, "[REDACTED]")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return `failed:${sanitized}`.slice(0, 500);
}

export function deliveryFailureAction(
  event: RepositoryEvent,
  error: unknown,
): ProposedAction {
  const reason = deliveryFailureStatus(error).slice("failed:".length).replaceAll("`", "'");
  const deliveryKey = event.deliveryId.replace(/[^a-z0-9]/gi, "").slice(0, 16);
  return {
    id: `failure-${deliveryKey}`,
    kind: "comment",
    target: {
      owner: event.repository.owner,
      repo: event.repository.repo,
      number: event.item.number,
    },
    parameters: {
      body:
        `Conflux Agent could not finish processing this event after ${EVENT_PROCESSING_ATTEMPTS} attempts.\n\n` +
        `Error: \`${reason}\``,
    },
    confidence: 1,
    evidence: [],
    rationale: "Report a terminal event-processing failure",
  };
}
