'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const UUID_RE      = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// security helpers

const SENSITIVE_RE = /\.env(\b|\.)|credential|secret|private[_.\-]?key|\.pem$|\.key$|\.p12$|\.pfx$|auth[_.\-]?token|api[_.\-]?key/i;

function isValidSessionId(id) {
  return typeof id === 'string' && UUID_RE.test(id);
}

// returns null if cwd is unsafe or unresolvable
function safeCwdToProjectDir(cwd) {
  if (!cwd || typeof cwd !== 'string') return null;
  if (cwd.includes('..')) return null;
  if (!path.isAbsolute(cwd)) return null;
  try {
    const parts = cwd.replace(/\\/g, '/').split('/').filter(Boolean);
    const encoded = parts.map(p => encodeURIComponent(p).replace(/%2F/g, '-')).join('-');
    const projectDir = path.join(os.homedir(), '.claude', 'projects', `-${encoded}`);
    return projectDir;
  } catch { return null; }
}

// only allows paths inside ~/.claude or ~/Library/Application Support/Claude
function safeFilePath(p) {
  if (!p || typeof p !== 'string') return false;
  try {
    const resolved = path.resolve(p);
    const home = os.homedir();
    return resolved.startsWith(path.join(home, '.claude')) ||
           resolved.startsWith(path.join(home, 'Library', 'Application Support', 'Claude'));
  } catch { return false; }
}

// tool input summarizer

function summarize(name, input) {
  if (!input) return '';
  try {
    switch (name) {
      case 'Read': case 'Write': case 'Edit': return input.file_path || '';
      case 'Glob':      return input.pattern || '';
      case 'Grep':      return `"${(input.pattern||'').slice(0, 60)}"`;
      case 'Bash':      return (input.command||'').slice(0, 80);
      case 'Agent': case 'Task': return input.description || input.prompt || '';
      case 'WebSearch': return `"${(input.query||'').slice(0, 60)}"`;
      case 'WebFetch':  return input.url || '';
      default:          return JSON.stringify(input).slice(0, 80);
    }
  } catch { return ''; }
}

// transcript file discovery

function findTranscript(sessionId, cwd) {
  if (!isValidSessionId(sessionId)) return null;
  if (cwd) {
    const projectDir = safeCwdToProjectDir(cwd);
    if (projectDir) {
      const p = path.join(projectDir, `${sessionId}.jsonl`);
      if (safeFilePath(p) && fs.existsSync(p)) return p;
    }
  }
  try {
    for (const proj of fs.readdirSync(PROJECTS_DIR)) {
      const p = path.join(PROJECTS_DIR, proj, `${sessionId}.jsonl`);
      if (safeFilePath(p) && fs.existsSync(p)) return p;
    }
  } catch {}
  return null;
}

// pricing (per million tokens)

const PRICING = {
  // Claude 4.x Sonnet
  'claude-sonnet-4-6':         { input: 3.0,  output: 15.0, cacheRead: 0.30, cacheWrite: 3.75 },
  'claude-sonnet-4-5':         { input: 3.0,  output: 15.0, cacheRead: 0.30, cacheWrite: 3.75 },
  'claude-sonnet-4-20250514':  { input: 3.0,  output: 15.0, cacheRead: 0.30, cacheWrite: 3.75 },
  // Claude 4.x Opus
  'claude-opus-4-6':           { input: 5.0,  output: 25.0, cacheRead: 0.50, cacheWrite: 6.25 },
  'claude-opus-4-5':           { input: 5.0,  output: 25.0, cacheRead: 0.50, cacheWrite: 6.25 },
  'claude-opus-4-1':           { input: 15.0, output: 75.0, cacheRead: 1.50, cacheWrite: 18.75 },
  'claude-opus-4-20250514':    { input: 15.0, output: 75.0, cacheRead: 1.50, cacheWrite: 18.75 },
  'claude-opus-3':             { input: 15.0, output: 75.0, cacheRead: 1.50, cacheWrite: 18.75 },
  // Haiku
  'claude-haiku-4-5':          { input: 1.0,  output: 5.0,  cacheRead: 0.10, cacheWrite: 1.25 },
  'claude-haiku-4-5-20251001': { input: 1.0,  output: 5.0,  cacheRead: 0.10, cacheWrite: 1.25 },
  'claude-haiku-3-5':          { input: 0.80, output: 4.0,  cacheRead: 0.08, cacheWrite: 1.0  },
  'claude-haiku-3':            { input: 0.25, output: 1.25, cacheRead: 0.03, cacheWrite: 0.30 },
};
const DEFAULT_PRICE = { input: 3.0, output: 15.0, cacheRead: 0.30, cacheWrite: 3.75 };

// transcript parsers

// reads first 100 lines only
function parseTranscriptMeta(filePath) {
  const meta = { permissionMode: null, entrypoint: null, version: null, gitBranch: null, model: null, label: null };
  try {
    const lines = fs.readFileSync(filePath, 'utf8').split('\n').slice(0, 100);
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.type === 'permission-mode' && obj.permissionMode) meta.permissionMode = obj.permissionMode;
        if (obj.permissionMode && obj.subtype === 'init') meta.permissionMode = obj.permissionMode;
        if (obj.entrypoint) meta.entrypoint = obj.entrypoint;
        if (obj.version)    meta.version    = obj.version;
        if (obj.gitBranch)  meta.gitBranch  = obj.gitBranch;
        if (obj.message?.model) meta.model  = obj.message.model;
        if (!meta.label && obj.type === 'user' && obj.message?.content) {
          const c = obj.message.content;
          const text = typeof c === 'string' ? c
            : (Array.isArray(c) ? c.filter(b => b.type === 'text').map(b => b.text).join('') : '');
          if (text && !text.startsWith('<') && !text.startsWith('/') && text.length > 5) {
            meta.label = text.replace(/\s+/g, ' ').trim().slice(0, 60);
          }
        }
      } catch {}
    }
  } catch {}
  return meta;
}

// summary comes from the user message whose parentUuid matches the boundary uuid
function parseTranscriptCompactions(filePath) {
  const results = [];
  try {
    const lines = fs.readFileSync(filePath, 'utf8').split('\n');
    const compactMap = new Map();

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.type === 'system' && obj.subtype === 'compact_boundary') {
          const meta = obj.compactMetadata || {};
          const sid  = obj.sessionId || '';
          const entry = {
            id:           `compact-${sid}-${obj.uuid || Date.now()}`,
            uuid:         obj.uuid,
            timestamp:    obj.timestamp ? new Date(obj.timestamp).getTime() : Date.now(),
            summary:      '',
            tokensBefore: meta.preTokens || null,
            tokensAfter:  meta.postTokens || null,
          };
          compactMap.set(obj.uuid, entry);
          results.push(entry);
        }
        if (obj.type === 'user' && obj.parentUuid && compactMap.has(obj.parentUuid)) {
          const entry = compactMap.get(obj.parentUuid);
          const content = obj.message?.content;
          if (typeof content === 'string' && content.length > 10) {
            entry.summary = content;
          } else if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'text' && block.text?.length > 10) { entry.summary = block.text; break; }
            }
          }
        }
      } catch {}
    }
  } catch {}
  return results;
}

// returns { inputTokens, outputTokens, cacheReadTokens, costUsd, isSubscription }
// isSubscription=true when Claude Code reports total_cost_usd=0 despite tokens (Max/Pro plan)
function parseTranscriptStats(filePath) {
  let inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheWriteTokens = 0;
  let model = null;
  let transcriptCost = null; // from result event — authoritative when present
  try {
    const lines = fs.readFileSync(filePath, 'utf8').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        // Capture authoritative cost from the result event
        if (obj.type === 'result' && typeof obj.total_cost_usd === 'number') {
          transcriptCost = obj.total_cost_usd;
        }
        const msg = obj.message;
        if (!msg) continue;
        if (msg.model && !model) model = msg.model;
        const u = msg.usage;
        if (!u) continue;
        inputTokens      += u.input_tokens                                    || 0;
        outputTokens     += u.output_tokens                                   || 0;
        cacheReadTokens  += u.cache_read_input_tokens                         || 0;
        cacheWriteTokens += (u.cache_creation?.ephemeral_5m_input_tokens     || 0)
                          + (u.cache_creation?.ephemeral_1h_input_tokens     || 0)
                          + (u.cache_creation_input_tokens                   || 0);
      } catch {}
    }
  } catch {}
  const price = (model && PRICING[model]) ? PRICING[model] : DEFAULT_PRICE;
  const calculatedCost = (inputTokens      * price.input      / 1e6)
                       + (outputTokens     * price.output     / 1e6)
                       + (cacheReadTokens  * price.cacheRead  / 1e6)
                       + (cacheWriteTokens * price.cacheWrite / 1e6);
  // Subscription detection: API users always have a cost in the result event; subscription
  // users either omit total_cost_usd entirely or report $0 — either way transcriptCost is
  // null or 0 while tokens were still consumed.
  const isSubscription = (transcriptCost === null || transcriptCost === 0) && inputTokens > 0;
  // For API users use the transcript's authoritative cost; for subscription show API-equivalent
  const costUsd = (transcriptCost !== null && transcriptCost > 0) ? transcriptCost : calculatedCost;
  return { inputTokens, outputTokens, cacheReadTokens, costUsd: Math.round(costUsd * 1e6) / 1e6, isSubscription };
}

// finds child session UUIDs referenced in Agent/Task tool results
function findChildSessionIds(filePath, rootSessionId) {
  const childIds = new Set();
  const projectDir = path.dirname(filePath);
  const agentToolUseIds = new Set();
  try {
    const lines = fs.readFileSync(filePath, 'utf8').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        for (const block of (obj.message?.content || [])) {
          if (block.type === 'tool_use' && (block.name === 'Agent' || block.name === 'Task')) {
            agentToolUseIds.add(block.id);
          }
          if (block.type === 'tool_result' && agentToolUseIds.has(block.tool_use_id)) {
            const text = typeof block.content === 'string'
              ? block.content : JSON.stringify(block.content || '');
            const uuids = text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g) || [];
            for (const uuid of uuids) {
              if (uuid === rootSessionId) continue;
              if (fs.existsSync(path.join(projectDir, `${uuid}.jsonl`))) childIds.add(uuid);
            }
          }
        }
      } catch {}
    }
  } catch {}
  return [...childIds];
}

// root cost includes all subagents — sum roots only to avoid double-counting
function parseFullSessionStats(filePath, rootSessionId, visited = new Set(), depth = 0) {
  if (depth > 50) return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0, isSubscription: false };
  if (visited.has(filePath)) return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0, isSubscription: false };
  visited.add(filePath);

  const stats = parseTranscriptStats(filePath);
  const childIds = findChildSessionIds(filePath, rootSessionId);

  for (const childId of childIds) {
    const childPath = path.join(path.dirname(filePath), `${childId}.jsonl`);
    const childStats = parseFullSessionStats(childPath, childId, visited, depth + 1);
    stats.inputTokens     += childStats.inputTokens;
    stats.outputTokens    += childStats.outputTokens;
    stats.cacheReadTokens += childStats.cacheReadTokens;
    stats.costUsd         += childStats.costUsd;
    if (childStats.isSubscription) stats.isSubscription = true;
  }
  stats.costUsd = Math.round(stats.costUsd * 1e6) / 1e6;
  return stats;
}

module.exports = {
  PROJECTS_DIR,
  SENSITIVE_RE,
  isValidSessionId,
  safeCwdToProjectDir,
  safeFilePath,
  summarize,
  findTranscript,
  PRICING,
  DEFAULT_PRICE,
  parseTranscriptMeta,
  parseTranscriptCompactions,
  parseTranscriptStats,
  findChildSessionIds,
  parseFullSessionStats,
};
