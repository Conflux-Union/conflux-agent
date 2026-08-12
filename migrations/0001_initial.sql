CREATE TABLE IF NOT EXISTS repository_items (
  installation_id INTEGER NOT NULL,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('issue', 'pull_request')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  state TEXT NOT NULL,
  labels_json TEXT NOT NULL DEFAULT '[]',
  summary TEXT NOT NULL DEFAULT '',
  content_hash TEXT NOT NULL,
  head_sha TEXT,
  base_branch TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (installation_id, owner, repo, number)
);

CREATE VIRTUAL TABLE IF NOT EXISTS repository_items_fts USING fts5(
  owner,
  repo,
  title,
  body,
  summary,
  content='repository_items',
  content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS repository_items_ai AFTER INSERT ON repository_items BEGIN
  INSERT INTO repository_items_fts(rowid, owner, repo, title, body, summary)
  VALUES (new.rowid, new.owner, new.repo, new.title, new.body, new.summary);
END;

CREATE TRIGGER IF NOT EXISTS repository_items_ad AFTER DELETE ON repository_items BEGIN
  INSERT INTO repository_items_fts(repository_items_fts, rowid, owner, repo, title, body, summary)
  VALUES ('delete', old.rowid, old.owner, old.repo, old.title, old.body, old.summary);
END;

CREATE TRIGGER IF NOT EXISTS repository_items_au AFTER UPDATE ON repository_items BEGIN
  INSERT INTO repository_items_fts(repository_items_fts, rowid, owner, repo, title, body, summary)
  VALUES ('delete', old.rowid, old.owner, old.repo, old.title, old.body, old.summary);
  INSERT INTO repository_items_fts(rowid, owner, repo, title, body, summary)
  VALUES (new.rowid, new.owner, new.repo, new.title, new.body, new.summary);
END;

CREATE TABLE IF NOT EXISTS relationships (
  source_owner TEXT NOT NULL,
  source_repo TEXT NOT NULL,
  source_number INTEGER NOT NULL,
  target_owner TEXT NOT NULL,
  target_repo TEXT NOT NULL,
  target_number INTEGER NOT NULL,
  relationship TEXT NOT NULL,
  confidence REAL NOT NULL,
  evidence_json TEXT NOT NULL,
  comparison_hash TEXT NOT NULL,
  manual_override INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (
    source_owner, source_repo, source_number,
    target_owner, target_repo, target_number
  )
);

CREATE TABLE IF NOT EXISTS deliveries (
  delivery_id TEXT PRIMARY KEY,
  received_at TEXT NOT NULL,
  event_name TEXT NOT NULL,
  repository TEXT NOT NULL,
  status TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS action_audit (
  action_id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  actor TEXT NOT NULL,
  parameters_json TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS model_usage (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cached_input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_status TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS repository_items_updated_idx
ON repository_items(owner, repo, updated_at DESC);

CREATE INDEX IF NOT EXISTS audit_target_idx
ON action_audit(owner, repo, number, created_at DESC);
