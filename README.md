# Conflux Agent

Conflux Agent is a stateful, model-driven GitHub maintenance agent for issues
and pull requests. It explores repository code and history when needed,
classifies repository work, synchronizes labels with native issue metadata,
finds related issues and pull requests, maintains native closing relationships,
and holds natural multi-turn conversations with reporters and maintainers.

## Architecture

- A Cloudflare Worker verifies GitHub webhooks and routes each issue or pull
  request to its own Cloudflare Agent instance.
- The Agent's SQLite-backed queue serializes events for one thread and stores a
  compact durable summary instead of replaying the full conversation.
- D1 stores the repository search index, relationship graph, delivery
  deduplication, action audit, and model usage.
- Repository rules live in `.github/maintainer-agent.yml` in each installed
  repository. A missing or invalid file disables writes for that repository.
- The model controls a bounded read-only exploration loop. It can search code,
  read files, list directories, inspect issues and pull requests, and inspect
  path history before returning a decision.
- Model output and tool calls are untrusted proposals. Read tools enforce
  repository and size limits, while deterministic policy validates every
  GitHub mutation before execution.
- The model classifies affected areas but cannot select assignees. Assignment
  uses bounded recent commit history for configured area paths, requires a clear
  dominant committer, and verifies that GitHub allows assigning that user.

## Safety model

- Webhook signatures and GitHub delivery IDs are verified before events enter
  an Agent queue.
- Issue, pull request, comment, image, diff, and repository text is untrusted
  model input.
- Conversation is restricted to repository code and maintenance. Explicit
  entertainment requests are rejected before a model call; other unrelated
  requests are classified and replaced with a fixed refusal at the action seam.
- Resolved issues are never closed directly. High-evidence pull requests receive
  a managed `Closes #N` block and GitHub closes the issue only after merge into
  the default branch.
- High-impact actions without sufficient evidence remain pending until a
  maintainer uses `/agent approve <action-id>`.
- Concrete duplicate relationships use their own configurable automatic-close
  threshold so an obvious duplicate does not wait behind unrelated action rules.
- Existing human metadata is authoritative. Relationship overrides are
  preserved until material content changes or `/agent reconsider` is used.

## Cost controls

- Native Type/Priority and label mirroring is deterministic and uses no model.
- Only reporter, pull request author, maintainer, or explicit Agent mentions
  wake conversational analysis.
- Each event receives a compact thread state plus incremental content. The model
  requests only the repository evidence needed for that turn.
- Model turns, tool calls, and each tool result are independently bounded by
  repository configuration.
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

`MODEL_BASE_URL` defaults to MiMo's Anthropic-compatible endpoint. The model
provider uses the Anthropic Messages protocol for text, images, and tool use.

## Repository configuration

The installed repository owns its rules in `.github/maintainer-agent.yml`.
Configuration names legal Type/Priority mappings, read-allowed repositories,
area-to-path ownership, automatic action thresholds, disabled labels, and
per-event model and tool budgets. Fields without an existing legal candidate
remain empty.
