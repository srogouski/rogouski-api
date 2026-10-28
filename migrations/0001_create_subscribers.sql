-- Migration: create subscribers table
-- Columns: id, email, created_at, confirmed, confirm_token

CREATE TABLE IF NOT EXISTS subscribers (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  confirmed     INTEGER NOT NULL DEFAULT 0,
  confirm_token TEXT NOT NULL UNIQUE
);

CREATE INDEX IF NOT EXISTS idx_subscribers_confirm_token
  ON subscribers (confirm_token);
