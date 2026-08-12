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
import {
  ModelProvider,
  relationshipComparisonHash,
  type CandidateContext,
} from "./model";
import {
  applyMetadataOverrides,
  metadataOverrideForEvent,
  planActions,
  planLabelMetadataMirror,
  planNativeMetadataMirror,
} from "./planner";
import { evaluateActions, mayApprove } from "./policy";
import { RepositoryStore, type SearchCandidate } from "./store";

const APPROVE_PATTERN = /^\/agent\s+approve\s+([a-f0-9]{8,64})\s*$/i;
const REJECT_PATTERN = /^\/agent\s+reject\s+([a-f0-9]{8,64})\s*$/i;
const RECONSIDER_PATTERN = /^\/agent\s+reconsider\s*$/i;

function deduplicateCandidates(candidates: CandidateContext[]): CandidateContext[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = `${candidate.owner.toLowerCase()}/${candidate.repo.toLowerCase()}#${candidate.number}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function searchQuery(event: RepositoryEvent, repositories: string[]): string {
  const terms = event.item.title
    .replace(/^\[[^\]]+\]\s*/, "")
    .replace(/[^\p{L}\p{N}_.-]+/gu, " ")
    .split(/\s+/)
    .filter((term) => term.length >= 2)
    .slice(0, 8)
    .map((term) => `"${term.replace(/"/g, "")}"`)
    .join(" ");
  const scopes = [
    `${event.repository.owner}/${event.repository.repo}`,
    ...repositories,
  ]
    .slice(0, 5)
    .map((repository) => `repo:${repository}`)
    .join(" ");
  return `${terms} ${scopes}`.trim();
}

function candidateFromGitHub(item: Record<string, any>): SearchCandidate {
  const repositoryUrl = String(item.repository_url ?? "");
  const match = repositoryUrl.match(/\/repos\/([^/]+)\/([^/]+)$/);
  return {
    owner: match?.[1] ?? "",
    repo: match?.[2] ?? "",
    number: Number(item.number),
    kind: item.pull_request ? "pull_request" : "issue",
    title: String(item.title ?? ""),
    summary: String(item.body ?? "").slice(0, 1500),
    state: String(item.state ?? "open"),
    contentHash: String(item.updated_at ?? ""),
  };
}

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

      const commandHandled = await this.handleCommand(event, github, config, store);
      if (commandHandled) {
        await store.markDelivery(event.deliveryId, "completed");
        return;
      }

      const { candidates, cachedRelationships } = await this.collectCandidates(
        event,
        github,
        config,
        store,
      );
      const model = new ModelProvider(this.env);
      const result = await model.decide({
        event,
        state: { ...this.state, relatedItems: cachedRelationships },
        config,
        candidates,
      });
      result.decision.classification = applyMetadataOverrides(
        result.decision.classification,
        this.state.manualOverrides,
      );
      result.decision.relationships = [
        ...result.decision.relationships,
        ...cachedRelationships,
      ];
      const contentHash = await store.upsertItem(event, result.decision.summary);
      await store.saveRelationships(event, result.decision.relationships);
      await store.recordUsage({
        ...result.usage,
        event,
        model: this.env.MODEL_NAME,
        promptVersion: this.env.PROMPT_VERSION,
      });

      const proposed = await planActions(event, this.state, result.decision, config);
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
          modelCalls: this.state.tokenUsage.modelCalls + 1,
        },
      });
      await store.markDelivery(event.deliveryId, "completed");
    } catch (error) {
      await store.markDelivery(event.deliveryId, "failed");
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

  private async collectCandidates(
    event: RepositoryEvent,
    github: GitHubClient,
    config: RepositoryConfig,
    store: RepositoryStore,
  ): Promise<{
    candidates: CandidateContext[];
    cachedRelationships: ThreadState["relatedItems"];
  }> {
    let currentPullFiles: Array<Record<string, any>> = [];
    if (event.item.kind === "pull_request") {
      if (!event.item.baseBranch || !event.item.headSha) {
        const pull = await github.getPull(
          event.repository.owner,
          event.repository.repo,
          event.item.number,
        );
        event.item.baseBranch = String(pull.base?.ref ?? "") || undefined;
        event.item.headSha = String(pull.head?.sha ?? "") || undefined;
      }
      currentPullFiles = await github.listPullFiles(
        event.repository.owner,
        event.repository.repo,
        event.item.number,
      );
    }
    const local = await store.search(
      event,
      config.search.repositories,
      config.search.maxCandidates,
    );
    let remote: SearchCandidate[] = [];
    const query = searchQuery(event, config.search.repositories);
    if (query) {
      const result = await github.searchIssuesAndPulls(query);
      remote = result.items.map(candidateFromGitHub).filter(
        (candidate) =>
          candidate.number !== event.item.number ||
          candidate.owner.toLowerCase() !== event.repository.owner.toLowerCase() ||
          candidate.repo.toLowerCase() !== event.repository.repo.toLowerCase(),
      );
    }
    const candidates = deduplicateCandidates([...local, ...remote]).slice(
      0,
      config.search.maxCandidates,
    );
    const deep: CandidateContext[] = [];
    const cachedRelationships: ThreadState["relatedItems"] = [];
    for (const candidate of candidates.slice(0, config.search.maxDeepComparisons)) {
      const item = await github.getIssue(candidate.owner, candidate.repo, candidate.number);
      const enriched: CandidateContext = {
        ...candidate,
        body: String(item.body ?? ""),
        contentHash: String(item.updated_at ?? candidate.contentHash),
      };
      if (candidate.kind === "pull_request") {
        const pull = await github.getPull(candidate.owner, candidate.repo, candidate.number);
        const files = await github.listPullFiles(candidate.owner, candidate.repo, candidate.number);
        enriched.body = String(pull.body ?? enriched.body ?? "");
        enriched.headSha = String(pull.head?.sha ?? "");
        enriched.baseBranch = String(pull.base?.ref ?? "");
        enriched.files = files.map((file) => String(file.filename));
        enriched.filePatches = files.map((file) => ({
          path: String(file.filename),
          patch: file.patch ? String(file.patch) : undefined,
        }));
        enriched.contentHash = String(pull.head?.sha ?? pull.updated_at ?? enriched.contentHash);
      } else if (event.item.kind === "pull_request") {
        enriched.files = currentPullFiles.map((file) => String(file.filename));
        enriched.filePatches = currentPullFiles.map((file) => ({
          path: String(file.filename),
          patch: file.patch ? String(file.patch) : undefined,
        }));
      }
      const comparisonHash = await relationshipComparisonHash(event, enriched);
      const cached = await store.cachedRelationship(event, enriched, comparisonHash);
      if (cached) cachedRelationships.push(cached);
      else deep.push(enriched);
    }
    return { candidates: deep, cachedRelationships };
  }
}
