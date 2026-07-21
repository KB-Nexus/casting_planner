CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  username TEXT,
  hostname TEXT,
  action TEXT NOT NULL,
  detail TEXT
);

CREATE INDEX idx_audit_log_ts ON audit_log (ts);
