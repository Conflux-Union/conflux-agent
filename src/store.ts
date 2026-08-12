import type { ProposedAction, RelationshipCandidate, RepositoryEvent } from "./domain";
import { sha256 } from "./crypto";

export class RepositoryStore {
  constructor(private readonly db: D1Database) {}

  async claimDelivery(event: RepositoryEvent): Promise<boolean> {
    const result = await this.db
      .prepare(
        "INSERT OR IGNORE INTO deliveries(delivery_id, received_at, event_name, repository, status) VALUES (?, ?, ?, ?, 'queued')",
      )
      .bind(
        event.deliveryId,
        new Date().toISOString(),
        event.eventName,
        `${event.repository.owner}/${event.repository.repo}`,
      )
      .run();
    return Number(result.meta.changes ?? 0) === 1;
  }

  async markDelivery(deliveryId: string, status: string): Promise<void> {
    await this.db.prepare("UPDATE deliveries SET status = ? WHERE delivery_id = ?").bind(status, deliveryId).run();
  }

  async upsertItem(event: RepositoryEvent, summary: string): Promise<string> {
    const contentHash = await sha256(
      JSON.stringify([
        event.item.title,
        event.item.body,
        event.item.labels,
        event.item.updatedAt,
        event.item.headSha,
      ]),
    );
    await this.db
      .prepare(
        `INSERT INTO repository_items(
          installation_id, owner, repo, number, kind, title, body, state, labels_json,
          summary, content_hash, head_sha, base_branch, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(installation_id, owner, repo, number) DO UPDATE SET
          kind=excluded.kind, title=excluded.title, body=excluded.body, state=excluded.state,
          labels_json=excluded.labels_json, summary=excluded.summary,
          content_hash=excluded.content_hash, head_sha=excluded.head_sha,
          base_branch=excluded.base_branch, updated_at=excluded.updated_at`,
      )
      .bind(
        event.repository.installationId,
        event.repository.owner,
        event.repository.repo,
        event.item.number,
        event.item.kind,
        event.item.title,
        event.item.body.slice(0, 30_000),
        event.item.state,
        JSON.stringify(event.item.labels),
        summary,
        contentHash,
        event.item.headSha ?? null,
        event.item.baseBranch ?? null,
        event.item.updatedAt,
      )
      .run();
    return contentHash;
  }

  async cachedRelationship(
    source: RepositoryEvent,
    candidate: {
      owner: string;
      repo: string;
      number: number;
      kind: "issue" | "pull_request";
    },
    comparisonHash: string,
  ): Promise<RelationshipCandidate | null> {
    const row = await this.db
      .prepare(
        `SELECT relationship, confidence, evidence_json AS evidenceJson
         FROM relationships
         WHERE source_owner=? AND source_repo=? AND source_number=?
           AND target_owner=? AND target_repo=? AND target_number=?
           AND comparison_hash=? AND manual_override=0`,
      )
      .bind(
        source.repository.owner,
        source.repository.repo,
        source.item.number,
        candidate.owner,
        candidate.repo,
        candidate.number,
        comparisonHash,
      )
      .first<{
        relationship: RelationshipCandidate["relationship"];
        confidence: number;
        evidenceJson: string;
      }>();
    if (!row) return null;
    return {
      owner: candidate.owner,
      repo: candidate.repo,
      number: candidate.number,
      kind: candidate.kind,
      relationship: row.relationship,
      confidence: row.confidence,
      evidence: JSON.parse(row.evidenceJson),
      contentHash: comparisonHash,
    };
  }

  async saveRelationships(event: RepositoryEvent, relationships: RelationshipCandidate[]): Promise<void> {
    const statements = relationships.map((relationship) =>
      this.db
        .prepare(
          `INSERT INTO relationships(
            source_owner, source_repo, source_number, target_owner, target_repo, target_number,
            relationship, confidence, evidence_json, comparison_hash, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(source_owner, source_repo, source_number, target_owner, target_repo, target_number)
          DO UPDATE SET relationship=excluded.relationship, confidence=excluded.confidence,
            evidence_json=excluded.evidence_json, comparison_hash=excluded.comparison_hash,
            updated_at=excluded.updated_at`,
        )
        .bind(
          event.repository.owner,
          event.repository.repo,
          event.item.number,
          relationship.owner,
          relationship.repo,
          relationship.number,
          relationship.relationship,
          relationship.confidence,
          JSON.stringify(relationship.evidence),
          relationship.contentHash,
          new Date().toISOString(),
        ),
    );
    if (statements.length) await this.db.batch(statements);
  }

  async auditAction(action: ProposedAction, status: string, actor: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db
      .prepare(
        `INSERT INTO action_audit(action_id, owner, repo, number, kind, status, actor,
          parameters_json, evidence_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(action_id) DO UPDATE SET status=excluded.status, actor=excluded.actor,
           updated_at=excluded.updated_at`,
      )
      .bind(
        action.id,
        action.target.owner,
        action.target.repo,
        action.target.number,
        action.kind,
        status,
        actor,
        JSON.stringify(action.parameters),
        JSON.stringify(action.evidence),
        now,
        now,
      )
      .run();
  }

  async recordUsage(input: {
    id: string;
    event: RepositoryEvent;
    model: string;
    promptVersion: string;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    cacheStatus?: string;
  }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO model_usage(id, owner, repo, number, model, prompt_version,
          input_tokens, output_tokens, cached_input_tokens, cache_status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        input.id,
        input.event.repository.owner,
        input.event.repository.repo,
        input.event.item.number,
        input.model,
        input.promptVersion,
        input.inputTokens,
        input.outputTokens,
        input.cachedInputTokens,
        input.cacheStatus ?? null,
        new Date().toISOString(),
      )
      .run();
  }
}
