# Conflux Agent

Conflux Agent is a stateful GitHub maintenance agent for issues and pull
requests. It classifies repository work, synchronizes labels with native issue
metadata, searches for related issues and pull requests, maintains native
closing relationships, and holds natural multi-turn conversations with
reporters and maintainers.

## Architecture

- A Cloudflare Worker verifies GitHub webhooks and routes each issue or pull
  request to its own Cloudflare Agent instance.
- The Agent's SQLite-backed queue serializes events for one thread and stores a
  compact durable summary instead of replaying the full conversation.
- D1 stores the repository search index, relationship graph, delivery
  deduplication, action audit, and model usage.
- Repository rules live in `.github/maintainer-agent.yml` in each installed
  repository. A missing or invalid file disables writes for that repository.
- Model output is an untrusted proposal. Deterministic policy code validates
  every GitHub mutation before execution.

## Safety model

- Webhook signatures and GitHub delivery IDs are verified before events enter
  an Agent queue.
- Issue, pull request, comment, image, diff, and repository text is untrusted
  model input.
- Resolved issues are never closed directly. High-evidence pull requests receive
  a managed `Closes #N` block and GitHub closes the issue only after merge into
  the default branch.
- High-impact actions without sufficient evidence remain pending until a
  maintainer uses `/agent approve <action-id>`.
- Existing human metadata is authoritative. Relationship overrides are
  preserved until material content changes or `/agent reconsider` is used.

## Cost controls

- Native Type/Priority and label mirroring is deterministic and uses no model.
- Only reporter, pull request author, maintainer, or explicit Agent mentions
  wake conversational analysis.
- Each event receives a compact thread state plus incremental content.
- Candidate search is limited before full issue, pull request, diff, and test
  context is loaded.
- Unchanged relationship comparisons are reused from D1 and omitted from later
  model input.
- The system prompt and tool contract remain a stable request prefix. Dynamic
  model responses bypass response caching; relationship comparisons use content
  hashes in D1.

## Development

```sh
npm ci
npm run typecheck
npm test
npm run deploy:dry
```

Apply D1 migrations locally with:

```sh
npx wrangler d1 migrations apply conflux-agent --local
```

Required Worker secrets:

- `GITHUB_APP_ID`
- `GITHUB_PRIVATE_KEY`
- `GITHUB_WEBHOOK_SECRET`
- `MODEL_API_KEY`

`MODEL_BASE_URL` defaults to the MiMo OpenAI-compatible endpoint. It can point
to a Cloudflare AI Gateway Custom Provider without changing the core Agent.

## Repository configuration

The installed repository owns its rules in `.github/maintainer-agent.yml`.
Configuration names legal Type/Priority mappings, searchable repositories,
area-to-path ownership, automatic action thresholds, disabled labels, and
per-event model budgets. Fields without an existing legal candidate remain
empty.
