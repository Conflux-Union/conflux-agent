import { Agent } from "agents";
import type { RepositoryConfig } from "./config";
import {
  INITIAL_THREAD_STATE,
  type ProposedAction,
  type RepositoryEvent,
  type ThreadState,
} from "./domain";
import type { Env } from "./env";
import { GitHubClient } from "./github";
import { ModelProvider } from "./model";
import {
  applyMetadataOverrides,
  metadataOverrideForEvent,
  planActions,
  planLabelMetadataMirror,
  planNativeMetadataMirror,
} from "./planner";
import { evaluateActions, mayApprove } from "./policy";
import { RepositoryStore } from "./store";
import { planCommitHistoryAssignment } from "./assignment";
import { isClearlyOffTopicRequest, offTopicReply } from "./scope";
import { RepositoryToolbox } from "./repository-tools";
import { deliveryFailureStatus } from "./delivery-status";

const APPROVE_PATTERN = /^\/agent\s+approve\s+([a-f0-9]{8,64})\s*$/i;
const REJECT_PATTERN = /^\/agent\s+reject\s+([a-f0-9]{8,64})\s*$/i;
const RECONSIDER_PATTERN = /^\/agent\s+reconsider\s*$/i;

function pendingMessage(actions: ProposedAction[]): string {
  const lines = actions.map(
    (action) =>
      `- \`${action.id}\` — ${action.kind}: ${action.rationale}\n  Evidence: ${
        action.evidence.length
          ? action.evidence.map((entry) => `\`${entry.reference}\``).join(", ")
          : "model analysis; deterministic evidence is incomplete"
      }`,
  );
  return [
    "I found actions that require maintainer approval:",
    "",
    ...lines,
    "",
    "A repository maintainer can run `/agent approve <action-id>` or `/agent reject <action-id>`.",
  ].join("\n");
}

function shouldProcessConversation(
  event: RepositoryEvent,
  config: RepositoryConfig,
): boolean {
  if (!event.comment) return true;
  const association = event.comment.authorAssociation;
  return (
    event.comment.author === event.item.author ||
    Boolean(
      association &&
        config.autonomy.trustedAssociations.includes(association as never),
    ) ||
    /@conflux-agent\b|^\/agent\b/im.test(event.comment.body)
  );
}

export class RepositoryThreadAgent extends Agent<Env, ThreadState> {
  initialState: ThreadState = INITIAL_THREAD_STATE;

  validateStateChange(nextState: ThreadState): void {
    if (nextState.summary.length > 5000) throw new Error("Thread summary is too large");
    if (nextState.pendingActions.length > 20) throw new Error("Too many pending actions");
  }

  async receiveEvent(event: RepositoryEvent): Promise<{ queued: boolean }> {
    await this.queue("processEvent", event, {
      retry: { maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 5000 },
    });
    return { queued: true };
  }

  async processEvent(event: RepositoryEvent): Promise<void> {
    const store = new RepositoryStore(this.env.DB);
    try {
      const github = await GitHubClient.forInstallation(
        this.env,
        event.repository.installationId,
      );
      const config = await github.loadConfig(event.repository.owner, event.repository.repo);
      if (!config?.enabled) {
        await store.markDelivery(event.deliveryId, "disabled");
        return;
      }

      const metadataOverride = metadataOverrideForEvent(event, config);
      if (metadataOverride) {
        const retained = this.state.manualOverrides.filter(
          (override) => override.kind !== "metadata" || override.key !== metadataOverride.key,
        );
        this.setState({
          ...this.state,
          classification: applyMetadataOverrides(this.state.classification, [metadataOverride]),
          manualOverrides: [...retained, metadataOverride],
        });
      } else if (event.action === "edited" || event.action === "synchronize") {
        this.setState({
          ...this.state,
          manualOverrides: this.state.manualOverrides.filter(
            (override) => override.kind !== "metadata",
          ),
        });
      }

      const mirror = [
        ...(await planNativeMetadataMirror(event, config)),
        ...(await planLabelMetadataMirror(event, config)),
      ];
      if (mirror.length) {
        const mirrorPolicy = evaluateActions(mirror, event, config);
        for (const action of mirrorPolicy.executable) {
          await github.execute(action, event, config);
          await store.auditAction(action, "executed", "native-field-mirror");
        }
        await store.upsertItem(event, this.state.summary);
        await store.markDelivery(event.deliveryId, "completed");
        return;
      }

      if (metadataOverride) {
        await store.upsertItem(event, this.state.summary);
        await store.markDelivery(event.deliveryId, "completed");
        return;
      }

      if (!shouldProcessConversation(event, config)) {
        await store.upsertItem(event, this.state.summary);
        await store.markDelivery(event.deliveryId, "ignored_unrelated_comment");
        return;
      }

      if (event.comment && isClearlyOffTopicRequest(event.comment.body)) {
        const refusal: ProposedAction = {
          id: crypto.randomUUID().replaceAll("-", "").slice(0, 16),
          kind: "comment",
          target: {
            owner: event.repository.owner,
            repo: event.repository.repo,
            number: event.item.number,
          },
          parameters: { body: offTopicReply(event.comment.body) },
          confidence: 1,
          evidence: [],
          rationale: "Decline an explicit off-topic request without a model call",
        };
        await github.execute(refusal, event, config);
        await store.auditAction(refusal, "executed", "scope-guard");
        await store.upsertItem(event, this.state.summary);
        this.setState({
          ...this.state,
          lastProcessedEvent: event.deliveryId,
          lastProcessedCommentId: event.comment.id,
        });
        await store.markDelivery(event.deliveryId, "completed");
        return;
      }

      const commandHandled = await this.handleCommand(event, github, config, store);
      if (commandHandled) {
        await store.markDelivery(event.deliveryId, "completed");
        return;
      }

      const hasManagedPriority = Object.values(config.metadata.priorities).some((mapping) =>
        event.item.labels.includes(mapping.label),
      );
      if (
        event.item.kind === "issue" &&
        config.metadata.priorityFieldId &&
        !hasManagedPriority
      ) {
        const values = await github.listIssueFieldValues(
          event.repository.owner,
          event.repository.repo,
          event.item.number,
        );
        const priority = values.find(
          (value) => Number(value.issue_field_id) === config.metadata.priorityFieldId,
        );
        event.item.nativePriority = priority?.single_select_option?.name
          ? String(priority.single_select_option.name)
          : priority?.value != null
            ? String(priority.value)
            : undefined;
      }

      const tools = new RepositoryToolbox(event, config, github, store);
      const model = new ModelProvider(this.env);
      const result = await model.decide({
        event,
        state: this.state,
        config,
        tools,
      });
      if (result.decision.requestScope === "off_topic") {
        result.decision.summary = this.state.summary;
        result.decision.knownFacts = this.state.knownFacts;
        result.decision.unresolvedQuestions = this.state.unresolvedQuestions;
        result.decision.classification = this.state.classification;
        result.decision.relationships = this.state.relatedItems;
        result.decision.actions = [];
        result.decision.normalizedTitle = undefined;
      }
      result.decision.classification = applyMetadataOverrides(
        result.decision.classification,
        this.state.manualOverrides,
      );
      const contentHash = await store.upsertItem(event, result.decision.summary);
      await store.saveRelationships(event, result.decision.relationships);
      await store.recordUsage({
        ...result.usage,
        event,
        model: this.env.MODEL_NAME,
        promptVersion: this.env.PROMPT_VERSION,
      });

      const proposed = await planActions(event, this.state, result.decision, config);
      const assignment = await planCommitHistoryAssignment(
        event,
        result.decision,
        config,
        github,
      );
      if (assignment) proposed.push(assignment);
      const policy = evaluateActions(proposed, event, config);
      for (const rejection of policy.rejected) {
        await store.auditAction(rejection.action, `rejected:${rejection.reason}`, "policy");
      }
      for (const action of policy.executable) {
        await github.execute(action, event, config);
        await store.auditAction(action, "executed", "conflux-agent");
      }
      for (const action of policy.pending) {
        await store.auditAction(action, "pending", "conflux-agent");
      }
      if (policy.pending.length) {
        const approvalComment: ProposedAction = {
          id: crypto.randomUUID().replaceAll("-", "").slice(0, 16),
          kind: "comment",
          target: {
            owner: event.repository.owner,
            repo: event.repository.repo,
            number: event.item.number,
          },
          parameters: { body: pendingMessage(policy.pending) },
          confidence: 1,
          evidence: [],
          rationale: "Request maintainer approval",
        };
        await github.execute(approvalComment, event, config);
        await store.auditAction(approvalComment, "executed", "conflux-agent");
      }

      this.setState({
        ...this.state,
        contentVersion: contentHash,
        summary: result.decision.summary,
        knownFacts: result.decision.knownFacts,
        unresolvedQuestions: result.decision.unresolvedQuestions,
        classification: result.decision.classification,
        relatedItems: result.decision.relationships,
        pendingActions: policy.pending,
        lastProcessedEvent: event.deliveryId,
        lastProcessedCommentId: event.comment?.id ?? this.state.lastProcessedCommentId,
        conversationStatus: result.decision.conversationStatus,
        tokenUsage: {
          inputTokens: this.state.tokenUsage.inputTokens + result.usage.inputTokens,
          outputTokens: this.state.tokenUsage.outputTokens + result.usage.outputTokens,
          cachedInputTokens:
            this.state.tokenUsage.cachedInputTokens + result.usage.cachedInputTokens,
          modelCalls: this.state.tokenUsage.modelCalls + result.usage.modelCalls,
        },
      });
      await store.markDelivery(event.deliveryId, "completed");
    } catch (error) {
      await store.markDelivery(event.deliveryId, deliveryFailureStatus(error));
      throw error;
    }
  }

  private async handleCommand(
    event: RepositoryEvent,
    github: GitHubClient,
    config: RepositoryConfig,
    store: RepositoryStore,
  ): Promise<boolean> {
    const body = event.comment?.body.trim();
    if (!body) return false;
    const approve = body.match(APPROVE_PATTERN);
    const reject = body.match(REJECT_PATTERN);
    const reconsider = body.match(RECONSIDER_PATTERN);
    if (!approve && !reject && !reconsider) return false;
    if (!mayApprove(event, config)) {
      const denied: ProposedAction = {
        id: crypto.randomUUID().replaceAll("-", "").slice(0, 16),
        kind: "comment",
        target: {
          owner: event.repository.owner,
          repo: event.repository.repo,
          number: event.item.number,
        },
        parameters: { body: "This command requires repository maintainer permission." },
        confidence: 1,
        evidence: [],
        rationale: "Reject unauthorized approval command",
      };
      await github.execute(denied, event, config);
      return true;
    }
    if (reconsider) {
      this.setState({
        ...this.state,
        manualOverrides: [],
        pendingActions: [],
        conversationStatus: "active",
      });
      return false;
    }
    const actionId = approve?.[1] ?? reject?.[1];
    const action = this.state.pendingActions.find((candidate) => candidate.id === actionId);
    if (!action) {
      const missing: ProposedAction = {
        id: crypto.randomUUID().replaceAll("-", "").slice(0, 16),
        kind: "comment",
        target: {
          owner: event.repository.owner,
          repo: event.repository.repo,
          number: event.item.number,
        },
        parameters: { body: `I could not find pending action \`${actionId}\`.` },
        confidence: 1,
        evidence: [],
        rationale: "Report an unknown pending action",
      };
      await github.execute(missing, event, config);
      return true;
    }
    if (approve) {
      await github.execute(action, event, config);
      await store.auditAction(action, "approved_and_executed", event.comment?.author ?? event.sender.login);
    } else {
      await store.auditAction(action, "rejected_by_maintainer", event.comment?.author ?? event.sender.login);
    }
    this.setState({
      ...this.state,
      pendingActions: this.state.pendingActions.filter((candidate) => candidate.id !== action.id),
      manualOverrides: reject
        ? [
            ...this.state.manualOverrides,
            {
              kind: action.kind,
              key: action.id,
              value: "rejected",
              actor: event.comment?.author ?? event.sender.login,
              at: new Date().toISOString(),
            },
          ]
        : this.state.manualOverrides,
    });
    return true;
  }
}
