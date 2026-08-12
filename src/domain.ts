export type ItemKind = "issue" | "pull_request";

export type ConversationStatus =
  | "active"
  | "waiting"
  | "ready"
  | "escalated"
  | "done";

export type RelationshipKind =
  | "resolves"
  | "partially_resolves"
  | "related"
  | "duplicate"
  | "conflicts"
  | "none";

export type ActionKind =
  | "comment"
  | "set_title"
  | "set_labels"
  | "set_issue_type"
  | "clear_issue_type"
  | "set_issue_field"
  | "clear_issue_field"
  | "set_milestone"
  | "set_assignees"
  | "add_to_project"
  | "link_closing_issue"
  | "close_issue";

export interface RepositoryRef {
  installationId: number;
  owner: string;
  repo: string;
  defaultBranch: string;
}

export interface RepositoryEvent {
  deliveryId: string;
  eventName: string;
  action: string;
  repository: RepositoryRef;
  item: {
    kind: ItemKind;
    number: number;
    nodeId?: string;
    title: string;
    body: string;
    state: "open" | "closed";
    author: string;
    authorAssociation?: string;
    assignees: string[];
    labels: string[];
    nativeIssueType?: string;
    nativePriority?: string;
    updatedAt: string;
    headSha?: string;
    baseBranch?: string;
  };
  sender: {
    login: string;
    type: string;
  };
  comment?: {
    id: number;
    body: string;
    author: string;
    authorAssociation?: string;
    updatedAt: string;
  };
  changedField?: {
    name: string;
    value?: string;
    previousValue?: string;
  };
  changedLabel?: string;
}

export interface Fact {
  key: string;
  value: string;
  source: string;
}

export interface Question {
  id: string;
  text: string;
  askedAt?: string;
  answered: boolean;
}

export interface EvidenceRef {
  kind: "issue" | "pull_request" | "comment" | "commit" | "file" | "test";
  reference: string;
  excerpt?: string;
}

export interface RelationshipCandidate {
  owner: string;
  repo: string;
  number: number;
  kind: ItemKind;
  relationship: RelationshipKind;
  confidence: number;
  evidence: EvidenceRef[];
  contentHash: string;
}

export interface Classification {
  issueKind?: string;
  priority?: string;
  areaLabels: string[];
}

export interface ProposedAction {
  id: string;
  kind: ActionKind;
  target: { owner: string; repo: string; number: number };
  parameters: Record<string, unknown>;
  confidence: number;
  evidence: EvidenceRef[];
  rationale: string;
  requiresApproval?: boolean;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  modelCalls: number;
}

export interface ThreadState {
  contentVersion: string;
  summary: string;
  knownFacts: Fact[];
  unresolvedQuestions: Question[];
  classification: Classification;
  relatedItems: RelationshipCandidate[];
  pendingActions: ProposedAction[];
  lastProcessedEvent?: string;
  lastProcessedCommentId?: number;
  conversationStatus: ConversationStatus;
  manualOverrides: Array<{
    kind: ActionKind | "relationship" | "metadata";
    key: string;
    value: string;
    actor: string;
    at: string;
  }>;
  tokenUsage: TokenUsage;
}

export interface AgentDecision {
  disposition: "reply" | "act" | "reply_and_act" | "wait" | "escalate";
  reply?: string;
  summary: string;
  knownFacts: Fact[];
  unresolvedQuestions: Question[];
  classification: Classification;
  normalizedTitle?: string;
  relationships: RelationshipCandidate[];
  actions: ProposedAction[];
  conversationStatus: ConversationStatus;
}

export const INITIAL_THREAD_STATE: ThreadState = {
  contentVersion: "",
  summary: "",
  knownFacts: [],
  unresolvedQuestions: [],
  classification: { areaLabels: [] },
  relatedItems: [],
  pendingActions: [],
  conversationStatus: "active",
  manualOverrides: [],
  tokenUsage: {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    modelCalls: 0,
  },
};
