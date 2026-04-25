#!/usr/bin/env node
'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const { isValidSessionId, findTranscript, SENSITIVE_RE } = require('../lib/parser');
const { createDb }    = require('../lib/db');
const { createStore } = require('../lib/session-store');

// config
const PORT     = process.env.PORT || 4243;
const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');

const DB_DIR  = process.env.AGENT_TRACER_DB
  ? path.dirname(process.env.AGENT_TRACER_DB)
  : path.join(os.homedir(), '.claude', 'agent-tracer');
const DB_PATH = process.env.AGENT_TRACER_DB || path.join(DB_DIR, 'traces.db');

const MAX_BODY_BYTES = 1_048_576; // 1 MB

// CLI flags — early exits before DB init
if (process.argv.includes('--help')) {
  console.log(`
  Usage: agent-tracer-daemon [options]

  Options:
    --install   Install Claude Code hooks into ~/.claude/settings.json
    --status    Check whether the daemon is running
    --help      Show this help message

  Environment variables:
    PORT                  HTTP port (default: 4243)
    AGENT_TRACER_DB       Path to SQLite database
                          (default: ~/.claude/agent-tracer/traces.db)
`);
  process.exit(0);
}

if (process.argv.includes('--status')) {
  const req = http.request({ hostname: 'localhost', port: PORT, path: '/health', method: 'GET' }, res => {
    let body = '';
    res.on('data', c => { body += c; });
    res.on('end', () => {
      try {
        const data = JSON.parse(body);
        console.log(`  Daemon running on port ${data.port}  |  sessions: ${data.sessions}`);
      } catch {
        console.log(`  Daemon responded but returned unexpected data: ${body}`);
      }
      process.exit(0);
    });
  });
  req.on('error', () => {
    console.log(`  Daemon is not running on port ${PORT}`);
    process.exit(1);
  });
  req.end();
  return;
}

// install hooks
if (process.argv.includes('--install')) {
  installHooks();
  process.exit(0);
}

function installHooks() {
  let settings = {};
  if (fs.existsSync(SETTINGS)) {
    try { settings = JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); } catch {}
  }
  const hookCmd = `curl -s -X POST http://localhost:${PORT}/hook -H 'Content-Type: application/json' -d @-`;
  settings.hooks = settings.hooks || {};
  function ensureHook(event) {
    settings.hooks[event] = settings.hooks[event] || [];
    if (!settings.hooks[event].some(h => h.hooks?.some(hh => hh.command?.includes(`localhost:${PORT}`)))) {
      settings.hooks[event].push({ hooks: [{ type: 'command', command: hookCmd }] });
    }
  }
  ensureHook('PreToolUse');
  ensureHook('PostToolUse');
  ensureHook('Stop');
  ensureHook('PreCompact');
  ensureHook('PostCompact');
  ensureHook('SessionStart');
  ensureHook('UserPromptSubmit');
  ensureHook('SubagentStop');
  ensureHook('PostToolUseFailure');
  ensureHook('SessionEnd');
  fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
  fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2));
  console.log(`✓ Hooks installed in ${SETTINGS}`);
  console.log(`  Start daemon: node bin/agent-tracer-daemon.js`);
  console.log(`  UI at:        http://localhost:${PORT}`);
}

// init db + session store
const { db, stmts, persistSession, persistTool, persistCompaction,
        persistPermDecision, persistNetRequest, persistFileAccess, persistHookEvent } = createDb(DB_PATH);
const store = createStore({ db, stmts, persistSession, persistTool, persistCompaction,
                             persistPermDecision, persistNetRequest, persistFileAccess, persistHookEvent });
const { sessions, clients, sessionList } = store;

store.loadHistory();
store.backfillCosts();
store.discoverChildSessions();
store.evictOldSessions();
store.backfillSecurityTables();

// Force fresh cost read 2s after startup (transcripts may have tokens the DB doesn't yet)
setTimeout(() => {
  const { findTranscript: ft, parseFullSessionStats } = require('../lib/parser');
  for (const node of sessions.values()) {
    const transcript = ft(node.sessionId, node.cwd);
    if (!transcript) continue;
    try {
      const stats = parseFullSessionStats(transcript, node.sessionId);
      if (stats.costUsd > 0 && Math.abs(stats.costUsd - node.costUsd) > 0.001) {
        node.tokens.input     = stats.inputTokens;
        node.tokens.output    = stats.outputTokens;
        node.tokens.cacheRead = stats.cacheReadTokens;
        node.costUsd          = stats.costUsd;
        persistSession(node);
        console.log(`  Refreshed ${node.sessionId.slice(0, 8)}: $${stats.costUsd.toFixed(4)}`);
      }
    } catch {}
  }
}, 2000);

setInterval(() => { store.refreshLiveCosts(); store.evictOldSessions(); }, 45000);

// CORS — localhost only; blocks third-party sites from reading session data
const LOCALHOST_RE = /^https?:\/\/localhost(:\d+)?$/;
function isAllowedOrigin(origin) { return !origin || LOCALHOST_RE.test(origin); }
function corsHeaders(req) {
  const origin = req.headers.origin || '';
  return isAllowedOrigin(origin) ? { 'Access-Control-Allow-Origin': origin || `http://localhost:${PORT}` } : {};
}

// HTTP server
const server = http.createServer((req, res) => {

  const origin = req.headers.origin;
  if (origin && !isAllowedOrigin(origin)) {
    res.writeHead(403); res.end('forbidden'); return;
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      ...corsHeaders(req),
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  // hook receiver
  if (req.method === 'POST' && req.url === '/hook') {
    let body = '', tooLarge = false;
    req.on('data', chunk => {
      if (tooLarge) return;
      body += chunk;
      if (body.length > MAX_BODY_BYTES) { tooLarge = true; res.writeHead(413); res.end('payload too large'); req.resume(); }
    });
    req.on('end', () => {
      if (tooLarge) return;
      try {
        const ev = JSON.parse(body);
        if (ev.session_id && !isValidSessionId(ev.session_id)) { res.writeHead(400); res.end('invalid session_id'); return; }
        if (ev.cwd && (ev.cwd.includes('..') || ev.cwd.includes('\0') || !path.isAbsolute(ev.cwd) || path.normalize(ev.cwd) !== ev.cwd)) {
          console.warn(`[hook] stripped unsafe cwd: ${JSON.stringify(ev.cwd)}`);
          delete ev.cwd;
        }
        if (ev.tool_input && JSON.stringify(ev.tool_input).length > 65536) ev.tool_input = { _truncated: true };
        store.handleHook(ev);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      } catch { res.writeHead(400); res.end('bad json'); }
    });
    return;
  }

  // SSE stream
  if (req.url === '/events') {
    if (clients.length >= 50) { res.writeHead(503); res.end('too many SSE clients'); return; }
    res.writeHead(200, {
      'Content-Type':      'text/event-stream',
      'Cache-Control':     'no-cache',
      'Connection':        'keep-alive',
      'X-Accel-Buffering': 'no',   // prevent nginx buffering
      ...corsHeaders(req),
    });
    res.write(`data: ${store.serializeTree()}\n\n`);
    clients.push(res);
    const hb = setInterval(() => {
      try { res.write(': heartbeat\n\n'); } catch {
        clearInterval(hb);
        const i = clients.indexOf(res);
        if (i >= 0) clients.splice(i, 1);
      }
    }, 3000);
    req.on('close', () => { clearInterval(hb); const i = clients.indexOf(res); if (i >= 0) clients.splice(i, 1); });
    return;
  }

  // sessions list
  if (req.url === '/api/sessions') {
    const rows = stmts.listRootSessions.all().filter(r => !store.hiddenSessions.has(r.id));
    res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders(req) });
    res.end(JSON.stringify(rows));
    return;
  }

  // rename session
  const renameMatch = req.url.match(/^\/api\/sessions\/([^/]+)\/rename$/);
  if (renameMatch && req.method === 'POST') {
    const sid = decodeURIComponent(renameMatch[1]);
    if (!isValidSessionId(sid) && !/^(sc-|child-)/.test(sid)) {
      res.writeHead(400, corsHeaders(req)); res.end('invalid session_id'); return;
    }
    let body = '', tooLarge = false;
    req.on('data', c => {
      if (tooLarge) return;
      body += c;
      if (body.length > 4096) { tooLarge = true; res.writeHead(413, corsHeaders(req)); res.end('payload too large'); req.resume(); }
    });
    req.on('end', () => {
      if (tooLarge) return;
      try {
        const { label } = JSON.parse(body || '{}');
        const ok = store.renameSession(sid, label);
        if (!ok) { res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders(req) }); res.end('{"ok":false}'); return; }
        res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders(req) });
        res.end('{"ok":true}');
      } catch { res.writeHead(400, corsHeaders(req)); res.end('bad json'); }
    });
    return;
  }

  // hide session (UI-only, no DB/file changes)
  const hideMatch = req.url.match(/^\/api\/sessions\/([^/]+)\/hide$/);
  if (hideMatch && req.method === 'POST') {
    const sid = decodeURIComponent(hideMatch[1]);
    store.hideSession(sid);
    res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders(req) });
    res.end('{"ok":true}');
    return;
  }

  // delete session permanently (drops all DB rows for the session and its descendants)
  const deleteMatch = req.url.match(/^\/api\/sessions\/([^/]+)\/delete$/);
  if (deleteMatch && req.method === 'POST') {
    const sid = decodeURIComponent(deleteMatch[1]);
    const ok = store.deleteSession(sid);
    res.writeHead(ok ? 200 : 500, { 'Content-Type': 'application/json', ...corsHeaders(req) });
    res.end(JSON.stringify({ ok }));
    return;
  }

  // single session
  const sessionMatch = req.url.match(/^\/api\/sessions\/([^/]+)$/);
  if (sessionMatch) {
    const sid = decodeURIComponent(sessionMatch[1]);
    if (!sessions.has(sid)) store.loadSessionTree(sid);
    const data = store.serializeSession(sid);
    if (!data) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders(req) });
    res.end(JSON.stringify(data));
    return;
  }

  // Strip system-injected XML tags from user messages
  function stripSystemTags(text) {
    if (!text || typeof text !== 'string') return text;
    // Remove block-level tags with all their content
    let cleaned = text.replace(/<(?:system-reminder|local-command-caveat|auto-memory|antml:thinking)[^>]*>[\s\S]*?<\/(?:system-reminder|local-command-caveat|auto-memory|antml:thinking)>/g, '');
    // Remove remaining opening/closing/self-closing system tags
    cleaned = cleaned.replace(/<\/?(?:system-reminder|local-command-caveat|command-name|command-args|command-message|local-command-stdout|local-command-stderr|antml:thinking|antml:thinking_mode|antml:reasoning_effort|user-prompt-submit-hook|command-output|tool-use-prompt|context-window-summary|search-results|attached-files|environment-info|claude-md|currentDate|auto-memory)(?:\s[^>]*)?>/g, '');
    // Collapse excess whitespace left behind
    return cleaned.replace(/\n{3,}/g, '\n\n').trim();
  }

  // conversation thread (async)
  const threadMatch = req.url.match(/^\/api\/sessions\/([^/]+)\/thread$/);
  if (threadMatch) {
    const sid = decodeURIComponent(threadMatch[1]);
    const node = sessions.get(sid) || (() => { store.loadSessionTree(sid); return sessions.get(sid); })();
    const transcript = findTranscript(sid, node?.cwd || null);
    if (!transcript) { res.writeHead(404); res.end('no transcript'); return; }

    fs.readFile(transcript, 'utf8', (err, fileData) => {
      if (err) { res.writeHead(500); res.end('read error'); return; }
      const messages = [];
      try {
        const lines = fileData.split('\n');
        const compactUuids = new Set();
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const obj = JSON.parse(line);
            if (obj.type === 'system' && obj.subtype === 'compact_boundary' && obj.uuid) compactUuids.add(obj.uuid);
          } catch {}
        }
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const obj = JSON.parse(line);
            const ts = obj.timestamp;
            if (obj.type === 'user' && obj.message?.content) {
              if (obj.parentUuid && compactUuids.has(obj.parentUuid)) continue;
              const content = obj.message.content;
              if (typeof content === 'string') {
                const cleaned = stripSystemTags(content);
                if (cleaned.length > 2) messages.push({ role: 'user', text: cleaned.slice(0, 20000), timestamp: ts });
              } else if (Array.isArray(content)) {
                for (const b of content) {
                  if (b.type === 'text' && b.text?.length > 2) {
                    const cleaned = stripSystemTags(String(b.text));
                    if (cleaned.length > 2) messages.push({ role: 'user', text: cleaned.slice(0, 20000), timestamp: ts });
                  } else if (b.type === 'tool_result') {
                    const txt = Array.isArray(b.content)
                      ? b.content.filter(x => x.type === 'text').map(x => x.text).join('\n')
                      : (typeof b.content === 'string' ? b.content : '');
                    if (txt && txt.trim()) {
                      messages.push({
                        role: 'tool_result',
                        text: txt.slice(0, 12000),
                        toolUseId: b.tool_use_id || null,
                        isError: !!b.is_error,
                        timestamp: ts,
                      });
                    }
                  }
                }
              }
            }
            if (obj.type === 'assistant' && obj.message?.content) {
              for (const b of (obj.message.content || [])) {
                if (b.type === 'text' && b.text?.trim()) {
                  messages.push({ role: 'assistant', text: String(b.text).slice(0, 20000), timestamp: ts });
                } else if (b.type === 'thinking' && b.thinking?.trim()) {
                  messages.push({ role: 'thinking', text: String(b.thinking).slice(0, 20000), timestamp: ts });
                } else if (b.type === 'tool_use') {
                  messages.push({
                    role: 'tool_use',
                    tool: b.name || '',
                    toolUseId: b.id || null,
                    input: b.input || {},
                    timestamp: ts,
                  });
                }
              }
            }
          } catch {}
        }
      } catch {}

      res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders(req) });
      res.end(JSON.stringify(messages));
    });
    return;
  }

  // permissions
  if (req.url === '/api/permissions') {
    function loadSettings(filePath) {
      try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return {}; }
    }
    const globalSettings = loadSettings(SETTINGS);
    const allNodes = [...sessions.values()];
    let cwd = allNodes.filter(n => n.cwd).sort((a, b) => b.startedAt - a.startedAt)[0]?.cwd || null;
    if (!cwd) {
      try { const row = db.prepare(`SELECT cwd FROM sessions WHERE cwd IS NOT NULL ORDER BY started_at DESC LIMIT 1`).get(); cwd = row?.cwd || null; } catch {}
    }
    let projectSettings = {}, projectLocalSettings = {};
    if (cwd) {
      projectSettings      = loadSettings(path.join(cwd, '.claude', 'settings.json'));
      projectLocalSettings = loadSettings(path.join(cwd, '.claude', 'settings.local.json'));
    }
    const recentNode = allNodes.filter(n => n.projectAllow || n.projectDeny).sort((a, b) => b.startedAt - a.startedAt)[0];
    if (!projectSettings.permissions && !projectLocalSettings.permissions && recentNode) {
      projectLocalSettings = { permissions: { allow: recentNode.projectAllow || [], deny: recentNode.projectDeny || [] } };
    }
    function mergePerms(...layers) {
      const allow = [], deny = [], ask = [], additionalDirs = [];
      let defaultMode = 'default';
      for (const s of layers) {
        const p = s.permissions || {};
        if (p.defaultMode) defaultMode = p.defaultMode;
        allow.push(...(p.allow || [])); deny.push(...(p.deny || [])); ask.push(...(p.ask || []));
        additionalDirs.push(...(p.additionalDirectories || []));
      }
      return { defaultMode, allow: [...new Set(allow)], deny: [...new Set(deny)], ask: [...new Set(ask)], additionalDirs: [...new Set(additionalDirs)] };
    }
    const perms = mergePerms(globalSettings, projectSettings, projectLocalSettings);

    function extractMcp(s) {
      return Object.entries(s.mcpServers || {}).map(([name, cfg]) => ({
        name, type: cfg.type || (cfg.command ? 'stdio' : cfg.url ? 'sse' : 'unknown'),
        command: cfg.command || cfg.url || null, args: cfg.args || [], enabled: true,
      }));
    }
    const mcpMap = new Map();
    const desktopCfg = loadSettings(path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'));
    for (const s of [...extractMcp(desktopCfg), ...extractMcp(globalSettings), ...extractMcp(projectSettings)]) mcpMap.set(s.name, s);

    const toolMap = new Map();
    for (const node of allNodes) {
      for (const tc of node.toolCalls) {
        const e = toolMap.get(tc.name) || { name: tc.name, calls: 0, totalMs: 0 };
        e.calls++; if (tc.durationMs) e.totalMs += tc.durationMs;
        toolMap.set(tc.name, e);
      }
    }

    const SENSITIVE_KEY_RE = /key|secret|token|password|credential|auth|pat$|dsn|connection.*url|database.*url|private/i;
    const SENSITIVE_VAL_RE = /^(ghp_|gho_|github_pat_|sk-|xox[bpsa]-|AKIA|eyJ|glpat-)/;
    const safeEnv = {};
    for (const [k, v] of Object.entries(globalSettings.env || {})) {
      safeEnv[k] = (SENSITIVE_KEY_RE.test(k) || SENSITIVE_VAL_RE.test(v)) ? '••••••' : v;
    }

    res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders(req) });
    res.end(JSON.stringify({
      defaultMode: perms.defaultMode, allow: perms.allow, deny: perms.deny, ask: perms.ask,
      fileAccess:  { cwd, additionalDirs: perms.additionalDirs, denied: perms.deny.filter(r => r.startsWith('Read(') || r === 'Read') },
      mcpServers:  [...mcpMap.values()],
      toolStats:   [...toolMap.values()].sort((a, b) => b.calls - a.calls),
      plugins:     Object.entries(globalSettings.enabledPlugins || {}).filter(([, v]) => v).map(([k]) => k),
      env: safeEnv,
    }));
    return;
  }

  // packages
  if (req.url === '/api/packages') {
    const allNodes = [...sessions.values()];
    const rootNodes = allNodes.filter(n => !n.parentSessionId);
    const recentNode = (rootNodes.length > 0 ? rootNodes : allNodes).sort((a, b) => b.startedAt - a.startedAt)[0];
    const cwd = recentNode?.cwd || null;
    const result = { cwd, npm: null, pip: null, other: [] };
    if (cwd) {
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
        result.npm = {
          name: pkg.name, version: pkg.version,
          deps:    Object.entries(pkg.dependencies    || {}).map(([n, v]) => ({ name: n, version: v, type: 'dep'  })),
          devDeps: Object.entries(pkg.devDependencies || {}).map(([n, v]) => ({ name: n, version: v, type: 'dev'  })),
        };
      } catch {}
    }
    if (!result.npm && recentNode?.packageJson) {
      const pkg = recentNode.packageJson;
      result.npm = {
        name: pkg.name, version: pkg.version,
        deps:    Object.entries(pkg.deps    || {}).map(([n, v]) => ({ name: n, version: v, type: 'dep' })),
        devDeps: Object.entries(pkg.devDeps || {}).map(([n, v]) => ({ name: n, version: v, type: 'dev' })),
      };
    }
    if (recentNode?.requirementsTxt) {
      result.pip = recentNode.requirementsTxt.map(l => {
        const [name, version] = l.split(/[=><~!]+/);
        return { name: name.trim(), version: (version || '').trim() };
      });
    }
    res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders(req) });
    res.end(JSON.stringify(result));
    return;
  }

  // projects
  if (req.url === '/api/projects') {
    const rows = db.prepare(`
      SELECT id, label, status, started_at, ended_at, cost_usd, cwd, permission_mode
      FROM sessions WHERE parent_id IS NULL ORDER BY started_at DESC LIMIT 300
    `).all();
    const projectMap = new Map();
    for (const row of rows) {
      const key = row.cwd || '__unknown__';
      if (!projectMap.has(key)) {
        const parts = (row.cwd || '').replace(/\\/g, '/').split('/').filter(Boolean);
        projectMap.set(key, { cwd: row.cwd || null, name: parts[parts.length - 1] || row.cwd || 'unknown', sessions: [] });
      }
      const proj = projectMap.get(key);
      if (proj.sessions.length < 20) proj.sessions.push(row);
    }
    const projects = [...projectMap.values()].sort((a, b) => (b.sessions[0]?.started_at || 0) - (a.sessions[0]?.started_at || 0));
    res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders(req) });
    res.end(JSON.stringify(projects));
    return;
  }

  // security audit
  if (req.url === '/api/security-audit') {
    function loadSettingsAudit(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; } }
    const gs = loadSettingsAudit(SETTINGS);
    const allNodes = [...sessions.values()];
    let cwdAudit = allNodes.filter(n => n.cwd).sort((a, b) => b.startedAt - a.startedAt)[0]?.cwd || null;
    if (!cwdAudit) { try { const r = db.prepare(`SELECT cwd FROM sessions WHERE cwd IS NOT NULL ORDER BY started_at DESC LIMIT 1`).get(); cwdAudit = r?.cwd || null; } catch {} }
    const ps  = cwdAudit ? loadSettingsAudit(path.join(cwdAudit, '.claude', 'settings.json'))       : {};
    const pls = cwdAudit ? loadSettingsAudit(path.join(cwdAudit, '.claude', 'settings.local.json')) : {};

    function extractAllHooks(settings, source) {
      const hooks = [];
      for (const [event, groups] of Object.entries(settings.hooks || {})) {
        if (!Array.isArray(groups)) continue;
        for (const group of groups) {
          for (const hook of (group.hooks || [])) {
            hooks.push({ event, matcher: group.matcher || null, type: hook.type || 'command', command: hook.command || hook.prompt || '', source });
          }
        }
      }
      return hooks;
    }

    const bashRows = db.prepare(`
      SELECT tc.session_id, tc.input_json, tc.started_at, tc.done, s.label, s.permission_mode
      FROM tool_calls tc JOIN sessions s ON tc.session_id = s.id
      WHERE tc.name = 'Bash' ORDER BY tc.started_at DESC LIMIT 300
    `).all();
    const bashCommands = bashRows.map(r => {
      let cmd = '';
      try { cmd = JSON.parse(r.input_json)?.command || ''; } catch {}
      return { sessionId: r.session_id, sessionLabel: r.label, command: cmd, startedAt: r.started_at, done: !!r.done, permissionMode: r.permission_mode || null };
    }).filter(r => r.command);

    const sensitiveFiles = db.prepare(`
      SELECT fa.id, fa.session_id, fa.tool, fa.file_path, fa.started_at, s.label AS session_label
      FROM file_accesses fa JOIN sessions s ON fa.session_id = s.id
      WHERE fa.sensitive = 1 ORDER BY fa.started_at DESC LIMIT 500
    `).all().map(r => ({
      sessionId: r.session_id, sessionLabel: r.session_label,
      tool: r.tool, filePath: r.file_path, startedAt: r.started_at,
    }));

    const webRequests = db.prepare(`
      SELECT nr.id, nr.session_id, nr.tool, nr.url, nr.domain, nr.flagged, nr.started_at,
             s.label AS session_label
      FROM network_requests nr JOIN sessions s ON nr.session_id = s.id
      ORDER BY nr.started_at DESC LIMIT 200
    `).all().map(r => ({
      sessionId: r.session_id, sessionLabel: r.session_label,
      tool: r.tool, url: r.url, domain: r.domain, flagged: !!r.flagged, startedAt: r.started_at,
    }));

    const bypassRows = db.prepare(`SELECT id, label, started_at, ended_at, status, cwd FROM sessions WHERE permission_mode = 'bypassPermissions' ORDER BY started_at DESC`).all();

    const blockedActions = db.prepare(`
      SELECT pd.id, pd.session_id, pd.tool_name, pd.summary, pd.recorded_at, s.label AS session_label
      FROM permission_decisions pd JOIN sessions s ON pd.session_id = s.id
      WHERE pd.decision = 'blocked' ORDER BY pd.recorded_at DESC LIMIT 100
    `).all().map(r => ({
      sessionId: r.session_id, sessionLabel: r.session_label,
      tool: r.tool_name, detail: r.summary, startedAt: r.recorded_at,
    }));

    const permissionDecisions = db.prepare(`
      SELECT pd.id, pd.session_id, pd.tool_name, pd.summary, pd.decision, pd.recorded_at,
             s.label AS session_label
      FROM permission_decisions pd JOIN sessions s ON pd.session_id = s.id
      ORDER BY pd.recorded_at DESC LIMIT 200
    `).all().map(r => ({
      id: r.id, sessionId: r.session_id, sessionLabel: r.session_label,
      toolName: r.tool_name, summary: r.summary, decision: r.decision, recordedAt: r.recorded_at,
    }));

    const hookEventCounts = db.prepare(`
      SELECT event_type, COUNT(*) AS count FROM hook_events GROUP BY event_type ORDER BY count DESC
    `).all();
    const recentHookEvents = db.prepare(`
      SELECT id, event_type, session_id, tool_name, recorded_at FROM hook_events ORDER BY id DESC LIMIT 50
    `).all().map(r => ({
      id: r.id, eventType: r.event_type, sessionId: r.session_id,
      toolName: r.tool_name, recordedAt: r.recorded_at,
    }));
    const hookActivity = { counts: hookEventCounts, recent: recentHookEvents };

    res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders(req) });
    res.end(JSON.stringify({
      hooks: [...extractAllHooks(gs, 'global'), ...extractAllHooks(ps, 'project'), ...extractAllHooks(pls, 'project-local')],
      bashCommands, sensitiveFiles, webRequests,
      bypassSessions: bypassRows, blockedActions,
      permissionDecisions, hookActivity,
    }));
    return;
  }

  // health
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, sessions: sessions.size, port: PORT }));
    return;
  }

  // serve risk.js
  if (req.method === 'GET' && req.url === '/risk.js') {
    const riskCandidates = [
      path.join(os.homedir(), 'Library', 'Application Support', 'agent-tracer', 'public', 'risk.js'),
      path.join(__dirname, '..', 'public', 'risk.js'),
    ];
    const riskPath = riskCandidates.find(p => fs.existsSync(p));
    if (!riskPath) { res.writeHead(404); res.end('risk.js not found'); return; }
    fs.readFile(riskPath, (err, data) => {
      if (err) { res.writeHead(500); res.end('read error'); return; }
      res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-store' });
      res.end(data);
    });
    return;
  }

  // serve UI
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    const uiCandidates = [
      path.join(os.homedir(), 'Library', 'Application Support', 'agent-tracer', 'public', 'index.html'),
      path.join(__dirname, '..', 'public', 'index.html'),
    ];
    const filePath = uiCandidates.find(p => fs.existsSync(p));
    if (!filePath) { res.writeHead(404); res.end('index.html not found'); return; }
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, {
        'Content-Type':             'text/html',
        'Cache-Control':            'no-store, no-cache, must-revalidate',
        'Pragma':                   'no-cache',
        'Content-Security-Policy':  `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self' data:; frame-ancestors 'none'`,
        'X-Content-Type-Options':   'nosniff',
        'X-Frame-Options':          'DENY',
      });
      res.end(data);
    });
    return;
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end('{"error":"not found"}');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Error: port ${PORT} already in use. Is the daemon already running?`);
    console.error(`  Stop it first:  pkill -f agent-tracer-daemon\n`);
  } else {
    console.error(`\n  Server error: ${err.message}\n`);
  }
  process.exit(1);
});

server.listen(PORT, () => {
  console.log(`\n  Agent Tracer Daemon → http://localhost:${PORT}`);
  console.log(`  DB                  → ${DB_PATH}`);
  console.log(`  Sessions loaded     → ${sessionList.length}`);
  console.log(`\n  To install hooks:   agent-tracer-daemon --install\n`);
});

process.on('SIGINT',  () => { db.close(); console.log('\n  Daemon stopped.\n'); process.exit(0); });
process.on('SIGTERM', () => { db.close(); process.exit(0); });
