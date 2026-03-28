/**
 * Database initialization and schema management for Agent Mailbox
 */

import { Database } from "bun:sqlite";
import type { ResolvedConfig } from "./types.js";

const SCHEMA_VERSION = 1;

export function initDatabase(config: ResolvedConfig): Database {
  const db = new Database(config.dbPath);

  if (config.walMode) {
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("PRAGMA synchronous=NORMAL");
  }
  db.exec("PRAGMA foreign_keys=ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_agent TEXT NOT NULL,
      to_agent TEXT NOT NULL,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('high', 'normal', 'low')),
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'read', 'acked', 'expired', 'dead')),
      ttl_seconds INTEGER NOT NULL DEFAULT 86400,
      idempotency_key TEXT,
      trace_id TEXT,
      receive_count INTEGER NOT NULL DEFAULT 0,
      visible_after TEXT,
      session_id TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      read_at TEXT,
      ack_at TEXT,
      expires_at TEXT NOT NULL DEFAULT (datetime('now', '+86400 seconds'))
    );

    CREATE INDEX IF NOT EXISTS idx_messages_to_agent_status ON messages(to_agent, status);
    CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id);
    CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
    CREATE INDEX IF NOT EXISTS idx_messages_expires ON messages(expires_at);
    CREATE INDEX IF NOT EXISTS idx_messages_visible ON messages(visible_after);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_idempotency ON messages(idempotency_key) WHERE idempotency_key IS NOT NULL;

    CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY,
      subject TEXT NOT NULL,
      participants TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_message_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS dead_letters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      original_message_id INTEGER NOT NULL,
      from_agent TEXT NOT NULL,
      to_agent TEXT NOT NULL,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      moved_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS rate_limits (
      agent TEXT NOT NULL,
      window_start TEXT NOT NULL,
      message_count INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (agent, window_start)
    );

    CREATE TABLE IF NOT EXISTS agent_registry (
      name TEXT PRIMARY KEY,
      role TEXT,
      registered_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_active TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // FTS5 for full-text search (separate try since it may already exist)
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        subject, body, content=messages, content_rowid=id
      );

      CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, subject, body) VALUES (new.id, new.subject, new.body);
      END;

      CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, subject, body) VALUES ('delete', old.id, old.subject, old.body);
      END;
    `);
  } catch {
    // FTS5 tables may already exist
  }

  // Set schema version
  const currentVersion = db.prepare("SELECT version FROM schema_version LIMIT 1").get() as { version: number } | null;
  if (!currentVersion) {
    db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(SCHEMA_VERSION);
  }

  return db;
}
