-- Local-only Feishu login support. Do not run against production or a remote D1.
-- Apply only after explicit approval; login/callback routes never create tables.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS local_auth_users (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_key TEXT NOT NULL,
  open_id TEXT,
  normalized_email TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  username TEXT NOT NULL,
  profile TEXT NOT NULL CHECK (profile = 'USER'),
  region TEXT,
  base TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  disabled_at INTEGER,
  UNIQUE (tenant_key, open_id)
);

CREATE TABLE IF NOT EXISTS local_auth_sessions (
  session_hash TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES local_auth_users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE TABLE IF NOT EXISTS feishu_oauth_states (
  state_hash TEXT PRIMARY KEY NOT NULL,
  code_verifier TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_local_auth_sessions_user ON local_auth_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_local_auth_sessions_expiry ON local_auth_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_feishu_oauth_states_expiry ON feishu_oauth_states(expires_at);
