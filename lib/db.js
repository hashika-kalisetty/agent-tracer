'use strict';

const fs       = require('fs');
const path     = require('path');
const Database = require('better-sqlite3');

function createDb(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);

  // migrations — safe to re-run on every boot
  try { db.exec(`ALTER TABLE sessions ADD COLUMN cwd TEXT`);             } catch {}
  try { db.exec(`ALTER TABLE sessions ADD COLUMN permission_mode TEXT`); } catch {}
  try { db.exec(`ALTER TABLE sessions ADD COLUMN entrypoint TEXT`);      } catch {}
  try { db.exec(`ALTER TABLE sessions ADD COLUMN version TEXT`);         } catch {}
  try { db.exec(`ALTER TABLE sessions ADD COLUMN git_branch TEXT`);      } catch {}
  try { db.exec(`ALTER TABLE sessions ADD COLUMN package_json TEXT`);    } catch {}
  try { db.exec(`ALTER TABLE tool_calls ADD COLUMN blocked INTEGER NOT NULL DEFAULT 0`); } catch {}
  try { db.exec(`ALTER TABLE sessions ADD COLUMN is_subscription INTEGER NOT NULL DEFAULT 0`); } catch {}

  // schema
  db.exec(`
    CREATE TABLE IF NOT EXISTS permission_decisions (
      id           TEXT PRIMARY KEY,
      session_id   TEXT NOT NULL,
      tool_name    TEXT NOT NULL DEFAULT '',
      summary      TEXT NOT NULL DEFAULT '',
      decision     TEXT NOT NULL,
      recorded_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS network_requests (
      id          TEXT PRIMARY KEY,
      session_id  TEXT NOT NULL,
      tool        TEXT NOT NULL,
      url         TEXT NOT NULL DEFAULT '',
      domain      TEXT NOT NULL DEFAULT '',
      flagged     INTEGER NOT NULL DEFAULT 0,
      started_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS file_accesses (
      id          TEXT PRIMARY KEY,
      session_id  TEXT NOT NULL,
      tool        TEXT NOT NULL,
      file_path   TEXT NOT NULL DEFAULT '',
      sensitive   INTEGER NOT NULL DEFAULT 0,
      started_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS hook_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type  TEXT NOT NULL DEFAULT '',
      session_id  TEXT NOT NULL DEFAULT '',
      tool_name   TEXT NOT NULL DEFAULT '',
      recorded_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_perm_decisions_session  ON permission_decisions(session_id);
    CREATE INDEX IF NOT EXISTS idx_perm_decisions_decision ON permission_decisions(decision, recorded_at DESC);
    CREATE INDEX IF NOT EXISTS idx_net_requests_session    ON network_requests(session_id);
    CREATE INDEX IF NOT EXISTS idx_net_requests_flagged    ON network_requests(flagged, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_file_accesses_session   ON file_accesses(session_id);
    CREATE INDEX IF NOT EXISTS idx_file_accesses_sensitive ON file_accesses(sensitive, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_hook_events_recorded    ON hook_events(recorded_at DESC);
    CREATE INDEX IF NOT EXISTS idx_hook_events_type        ON hook_events(event_type, recorded_at DESC);

    CREATE TABLE IF NOT EXISTS sessions (
      id              TEXT PRIMARY KEY,
      parent_id       TEXT,
      label           TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'running',
      started_at      INTEGER NOT NULL,
      ended_at        INTEGER,
      cost_usd        REAL NOT NULL DEFAULT 0,
      tokens_in       INTEGER NOT NULL DEFAULT 0,
      tokens_out      INTEGER NOT NULL DEFAULT 0,
      cache_read      INTEGER NOT NULL DEFAULT 0,
      last_text       TEXT NOT NULL DEFAULT '',
      cwd             TEXT,
      permission_mode TEXT,
      entrypoint      TEXT,
      version         TEXT,
      git_branch      TEXT,
      package_json    TEXT,
      is_subscription INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS tool_calls (
      id          TEXT PRIMARY KEY,
      session_id  TEXT NOT NULL REFERENCES sessions(id),
      name        TEXT NOT NULL,
      summary     TEXT NOT NULL DEFAULT '',
      input_json  TEXT,
      done        INTEGER NOT NULL DEFAULT 0,
      blocked     INTEGER NOT NULL DEFAULT 0,
      started_at  INTEGER NOT NULL,
      duration_ms INTEGER
    );

    CREATE TABLE IF NOT EXISTS compactions (
      id             TEXT PRIMARY KEY,
      session_id     TEXT NOT NULL REFERENCES sessions(id),
      timestamp      INTEGER NOT NULL,
      tokens_before  INTEGER,
      tokens_after   INTEGER,
      summary        TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_parent    ON sessions(parent_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_started   ON sessions(started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls(session_id);
  `);

  // prepared statements
  const stmts = {
    upsertSession: db.prepare(`
      INSERT INTO sessions(id, parent_id, label, status, started_at, ended_at, cost_usd,
        tokens_in, tokens_out, cache_read, last_text, cwd, permission_mode, entrypoint,
        version, git_branch, package_json, is_subscription)
      VALUES(@id, @parent_id, @label, @status, @started_at, @ended_at, @cost_usd,
        @tokens_in, @tokens_out, @cache_read, @last_text, @cwd, @permission_mode, @entrypoint,
        @version, @git_branch, @package_json, @is_subscription)
      ON CONFLICT(id) DO UPDATE SET
        label=excluded.label, status=excluded.status, ended_at=excluded.ended_at,
        cost_usd=excluded.cost_usd, tokens_in=excluded.tokens_in, tokens_out=excluded.tokens_out,
        cache_read=excluded.cache_read, last_text=excluded.last_text, cwd=excluded.cwd,
        permission_mode=excluded.permission_mode, entrypoint=excluded.entrypoint,
        version=excluded.version, git_branch=excluded.git_branch,
        package_json=COALESCE(excluded.package_json, package_json),
        is_subscription=excluded.is_subscription
    `),

    upsertTool: db.prepare(`
      INSERT INTO tool_calls(id, session_id, name, summary, input_json, done, blocked, started_at, duration_ms)
      VALUES(@id, @session_id, @name, @summary, @input_json, @done, @blocked, @started_at, @duration_ms)
      ON CONFLICT(id) DO UPDATE SET
        done=excluded.done, blocked=excluded.blocked, duration_ms=excluded.duration_ms, summary=excluded.summary
    `),

    upsertCompaction: db.prepare(`
      INSERT INTO compactions(id, session_id, timestamp, tokens_before, tokens_after, summary)
      VALUES(@id, @session_id, @timestamp, @tokens_before, @tokens_after, @summary)
      ON CONFLICT(id) DO UPDATE SET
        tokens_after=excluded.tokens_after, summary=excluded.summary
    `),

    listRootSessions: db.prepare(`
      SELECT id, label, status, started_at, ended_at, cost_usd,
             tokens_in, tokens_out, cache_read, cwd, permission_mode, is_subscription
      FROM sessions WHERE parent_id IS NULL
      ORDER BY started_at DESC LIMIT 500
    `),

    getSession: db.prepare(`
      SELECT id, parent_id, label, status, started_at, ended_at, cost_usd,
             tokens_in, tokens_out, cache_read, last_text, cwd, permission_mode,
             entrypoint, version, git_branch, package_json, is_subscription
      FROM sessions WHERE id = ?
    `),

    getToolCalls:  db.prepare(`SELECT * FROM tool_calls  WHERE session_id = ? ORDER BY started_at`),
    getCompactions: db.prepare(`SELECT * FROM compactions WHERE session_id = ? ORDER BY timestamp`),
    getChildren:    db.prepare(`SELECT id FROM sessions   WHERE parent_id  = ? ORDER BY started_at`),

    insertPermDecision: db.prepare(`
      INSERT OR IGNORE INTO permission_decisions(id, session_id, tool_name, summary, decision, recorded_at)
      VALUES(@id, @session_id, @tool_name, @summary, @decision, @recorded_at)
    `),
    insertNetRequest: db.prepare(`
      INSERT OR IGNORE INTO network_requests(id, session_id, tool, url, domain, flagged, started_at)
      VALUES(@id, @session_id, @tool, @url, @domain, @flagged, @started_at)
    `),
    insertFileAccess: db.prepare(`
      INSERT OR IGNORE INTO file_accesses(id, session_id, tool, file_path, sensitive, started_at)
      VALUES(@id, @session_id, @tool, @file_path, @sensitive, @started_at)
    `),
    insertHookEvent: db.prepare(`
      INSERT INTO hook_events(event_type, session_id, tool_name, recorded_at)
      VALUES(@event_type, @session_id, @tool_name, @recorded_at)
    `),
    trimHookEvents: db.prepare(`
      DELETE FROM hook_events WHERE id NOT IN (
        SELECT id FROM hook_events ORDER BY id DESC LIMIT 10000
      )
    `),
  };

  // persist helpers

  function persistSession(node) {
    if (node.isSidechain) return; // virtual nodes — never persisted
    stmts.upsertSession.run({
      id:              node.sessionId,
      parent_id:       node.parentSessionId || null,
      label:           node.label,
      status:          node.status,
      started_at:      node.startedAt,
      ended_at:        node.endedAt || null,
      cost_usd:        node.costUsd,
      tokens_in:       node.tokens.input,
      tokens_out:      node.tokens.output,
      cache_read:      node.tokens.cacheRead,
      last_text:       node.lastText       || '',
      cwd:             node.cwd            || null,
      permission_mode: node.permissionMode || null,
      entrypoint:      node.entrypoint     || null,
      version:         node.version        || null,
      git_branch:      node.gitBranch      || null,
      package_json:    node.packageJson ? JSON.stringify(node.packageJson) : null,
      is_subscription: node.isSubscription ? 1 : 0,
    });
  }

  function persistTool(tc) {
    stmts.upsertTool.run({
      id:          tc.id,
      session_id:  tc.sessionId,
      name:        tc.name,
      summary:     tc.summary,
      input_json:  tc.input ? JSON.stringify(tc.input) : null,
      done:        tc.done    ? 1 : 0,
      blocked:     tc.blocked ? 1 : 0,
      started_at:  tc.startedAt,
      duration_ms: tc.durationMs || null,
    });
  }

  function persistCompaction(c, sessionId) {
    stmts.upsertCompaction.run({
      id:            c.id,
      session_id:    sessionId,
      timestamp:     c.timestamp,
      tokens_before: c.tokensBefore || null,
      tokens_after:  c.tokensAfter  || null,
      summary:       c.summary || null,
    });
  }

  function persistPermDecision({ id, sessionId, toolName, summary, decision }) {
    if (!id) return;
    stmts.insertPermDecision.run({
      id, session_id: sessionId, tool_name: toolName || '',
      summary: summary || '', decision, recorded_at: Date.now(),
    });
  }

  function persistNetRequest({ id, sessionId, tool, url, domain, flagged }) {
    if (!id) return;
    stmts.insertNetRequest.run({
      id, session_id: sessionId, tool, url: url || '',
      domain: domain || '', flagged: flagged ? 1 : 0, started_at: Date.now(),
    });
  }

  function persistFileAccess({ id, sessionId, tool, filePath, sensitive }) {
    if (!id) return;
    stmts.insertFileAccess.run({
      id, session_id: sessionId, tool,
      file_path: filePath || '', sensitive: sensitive ? 1 : 0, started_at: Date.now(),
    });
  }

  function persistHookEvent({ eventType, sessionId, toolName }) {
    stmts.insertHookEvent.run({
      event_type: eventType || '', session_id: sessionId || '',
      tool_name: toolName || '', recorded_at: Date.now(),
    });
  }

  return { db, stmts, persistSession, persistTool, persistCompaction,
           persistPermDecision, persistNetRequest, persistFileAccess, persistHookEvent };
}

module.exports = { createDb };
