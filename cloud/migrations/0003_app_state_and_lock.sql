CREATE TABLE app_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  payload TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  updated_by_username TEXT,
  updated_by_hostname TEXT
);

CREATE TABLE app_lock (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  token TEXT,
  username TEXT,
  hostname TEXT,
  acquired_at TEXT,
  renewed_at TEXT,
  lease_ms INTEGER,
  expires_at TEXT
);

INSERT INTO app_lock (id, token, username, hostname, acquired_at, renewed_at, lease_ms, expires_at)
VALUES (1, NULL, NULL, NULL, NULL, NULL, NULL, NULL);

CREATE TABLE app_state_backup (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stamp TEXT NOT NULL,
  payload TEXT NOT NULL,
  version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  created_by_username TEXT,
  created_by_hostname TEXT
);

CREATE INDEX idx_app_state_backup_stamp ON app_state_backup (stamp);
