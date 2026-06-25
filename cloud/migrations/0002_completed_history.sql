CREATE TABLE IF NOT EXISTS completed_history (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  payload TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
