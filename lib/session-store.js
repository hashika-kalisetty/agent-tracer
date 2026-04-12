'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const {
  isValidSessionId, safeFilePath, summarize, findTranscript,
  parseTranscriptMeta, parseTranscriptCompactions,
  parseTranscriptStats, parseFullSessionStats,
  findChildSessionIds, PROJECTS_DIR, SENSITIVE_RE,
} = require('./parser');

function createStore({ db, stmts, persistSession, persistTool, persistCompaction,
                       persistPermDecision, persistNetRequest, persistFileAccess, persistHookEvent }) {

  // in-memory state
  const sessions    = new Map(); // sessionId → AgentNode
  const toolCallMap = new Map(); // toolUseId → { sessionId, call }
  const sessionList = [];        // ordered root session IDs
  const clients     = [];        // SSE response objects
  let   compactSeq  = Date.now(); // monotonic counter for fallback compaction IDs (seeded from clock to avoid collisions across restarts)

  // SSE broadcast
  function broadcast() {
    const data = `data: ${serializeTree()}\n\n`;
    for (let i = clients.length - 1; i >= 0; i--) {
      try { clients[i].write(data); }
      catch { clients.splice(i, 1); }
    }
  }

  // load history from DB on startup
  function loadHistory() {
    const roots = stmts.listRootSessions.all();
    for (const row of roots) loadSessionTree(row.id);
    for (const row of [...roots].reverse()) {
      if (!sessionList.includes(row.id)) sessionList.push(row.id);
    }
  }

  function loadSessionTree(sessionId) {
    if (sessions.has(sessionId)) return sessions.get(sessionId);

    const row = stmts.getSession.get(sessionId);
    if (!row) return null;

    const toolRows  = stmts.getToolCalls.all(sessionId);
    const compRows  = stmts.getCompactions.all(sessionId);
    const childRows = stmts.getChildren.all(sessionId);

    const node = {
      sessionId:      row.id,
      parentSessionId: row.parent_id || null,
      label:          row.label,
      status:         row.status,
      startedAt:      row.started_at,
      endedAt:        row.ended_at || null,
      tokens:         { input: row.tokens_in, output: row.tokens_out, cacheRead: row.cache_read },
      costUsd:        row.cost_usd,
      isSubscription: !!row.is_subscription,
      lastText:       row.last_text       || '',
      cwd:            row.cwd             || null,
      permissionMode: row.permission_mode || null,
      entrypoint:     row.entrypoint      || null,
      version:        row.version         || null,
      gitBranch:      row.git_branch      || null,
      packageJson:    row.package_json ? (() => { try { return JSON.parse(row.package_json); } catch { return null; } })() : null,
      toolCalls: toolRows.map(t => ({
        id: t.id, name: t.name, summary: t.summary,
        input: t.input_json ? (() => { try { return JSON.parse(t.input_json); } catch { return {}; } })() : {},
        done: !!t.done || row.status !== 'running',
        startedAt: t.started_at, durationMs: t.duration_ms,
      })),
      compactions: compRows.map(c => ({
        id: c.id, timestamp: c.timestamp,
        tokensBefore: c.tokens_before, tokensAfter: c.tokens_after,
        summary: c.summary || '',
      })),
      children: childRows.map(c => c.id),
    };

    sessions.set(sessionId, node);
    for (const child of childRows) loadSessionTree(child.id);
    return node;
  }

  // startup backfill
  function backfillCosts() {
    for (const node of sessions.values()) {
      const needsCost     = node.costUsd === 0 && node.tokens.input === 0;
      const needsMeta     = !node.permissionMode && !node.entrypoint;
      const cwdFolder     = node.cwd ? node.cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() : null;
      const needsLabel    = node.label === `agent-${node.sessionId.slice(0, 8)}` || node.label === cwdFolder;
      const needsCompacts = node.compactions.length === 0;
      if (!needsCost && !needsMeta && !needsLabel && !needsCompacts) continue;

      const transcript = findTranscript(node.sessionId, node.cwd);
      if (!transcript) continue;

      let changed = false;
      if (needsCost) {
        const stats = parseFullSessionStats(transcript, node.sessionId);
        if (stats.inputTokens > 0 || stats.outputTokens > 0) {
          node.tokens.input     = stats.inputTokens;
          node.tokens.output    = stats.outputTokens;
          node.tokens.cacheRead = stats.cacheReadTokens;
          node.costUsd          = stats.costUsd;
          node.isSubscription   = stats.isSubscription || false;
          if (node.status === 'running') node.status = 'done';
          console.log(`  Backfilled ${node.sessionId.slice(0, 8)}: $${stats.costUsd.toFixed(4)}${stats.isSubscription ? ' (subscription)' : ''}`);
          changed = true;
        }
      }
      if (needsMeta || needsLabel) {
        const tmeta = parseTranscriptMeta(transcript);
        if (needsMeta) {
          if (tmeta.permissionMode) { node.permissionMode = tmeta.permissionMode; changed = true; }
          if (tmeta.entrypoint)     { node.entrypoint     = tmeta.entrypoint;     changed = true; }
          if (tmeta.version)        { node.version        = tmeta.version;        changed = true; }
          if (tmeta.gitBranch)      { node.gitBranch      = tmeta.gitBranch;      changed = true; }
        }
        if (needsLabel && tmeta.label) { node.label = tmeta.label; changed = true; }
      }
      if (needsCompacts) {
        const compacts = parseTranscriptCompactions(transcript);
        for (const c of compacts) {
          node.compactions.push(c);
          persistCompaction(c, node.sessionId);
        }
        if (compacts.length > 0) changed = true;
      }
      if (changed) persistSession(node);
    }
  }

  // discovers worktree/background sessions; synthesises virtual sidechain nodes for inline agents
  function discoverChildSessions() {
    const knownIds = new Set(sessions.keys());

    // Gather unrecognised JSONL files across all project dirs
    const candidates = [];
    try {
      for (const dirEntry of fs.readdirSync(PROJECTS_DIR)) {
        const projectDir = path.join(PROJECTS_DIR, dirEntry);
        try { if (!fs.statSync(projectDir).isDirectory()) continue; } catch { continue; }
        let files;
        try { files = fs.readdirSync(projectDir).filter(f => f.endsWith('.jsonl')); } catch { continue; }
        for (const file of files) {
          const childId = file.replace('.jsonl', '');
          if (!isValidSessionId(childId) || knownIds.has(childId)) continue;
          const childPath = path.join(projectDir, file);
          if (!safeFilePath(childPath)) continue;
          candidates.push({ childId, childPath });
        }
      }
    } catch {}

    function readChildMeta(childPath) {
      let firstPrompt = null, startedAt = null, endedAt = null, cwd = null;
      try {
        const lines = fs.readFileSync(childPath, 'utf8').split('\n');
        for (const line of lines.slice(0, 30)) {
          if (!line.trim()) continue;
          try {
            const obj = JSON.parse(line);
            if (!startedAt && obj.timestamp) startedAt = new Date(obj.timestamp).getTime();
            if (!cwd && obj.cwd) cwd = obj.cwd;
            if (!firstPrompt && obj.type === 'user' && obj.message?.content) {
              const c = obj.message.content;
              const text = typeof c === 'string' ? c
                : (Array.isArray(c) ? c.filter(b => b.type === 'text').map(b => b.text).join('') : '');
              if (text && !text.startsWith('<') && !text.startsWith('/') && text.length > 10)
                firstPrompt = text.trim();
            }
            if (firstPrompt && startedAt && cwd) break;
          } catch {}
        }
        for (let i = lines.length - 1; i >= 0; i--) {
          const l = lines[i].trim();
          if (!l) continue;
          try { const obj = JSON.parse(l); if (obj.timestamp) { endedAt = new Date(obj.timestamp).getTime(); break; } } catch {}
        }
      } catch {}
      return { firstPrompt, startedAt, endedAt, cwd };
    }

    for (const node of [...sessions.values()]) {
      const transcript = findTranscript(node.sessionId, node.cwd);
      if (!transcript) continue;

      const agentCalls   = [];
      const agentResults = new Map();

      try {
        for (const line of fs.readFileSync(transcript, 'utf8').split('\n')) {
          if (!line.trim()) continue;
          try {
            const obj = JSON.parse(line);
            for (const block of (obj.message?.content || [])) {
              if ((block.name === 'Agent' || block.name === 'Task') && block.input?.prompt) {
                agentCalls.push({
                  toolUseId:    block.id,
                  prompt:       block.input.prompt,
                  description:  block.input.description || '',
                  isBackground: !!block.input.run_in_background,
                  isolation:    block.input.isolation || null,
                });
              }
              if (block.type === 'tool_result') {
                const txt = Array.isArray(block.content)
                  ? block.content.filter(b => b.type === 'text').map(b => b.text).join('')
                  : (typeof block.content === 'string' ? block.content : '');
                if (txt) agentResults.set(block.tool_use_id, txt);
              }
            }
          } catch {}
        }
      } catch {}

      if (!agentCalls.length) continue;

      const matchedToolUseIds = new Set();

      for (const { childId, childPath } of candidates) {
        if (sessions.has(childId)) continue;
        const { firstPrompt, startedAt, endedAt, cwd: childCwd } = readChildMeta(childPath);
        if (!firstPrompt) continue;

        const needle = firstPrompt.slice(0, 80).toLowerCase();
        let matchedCall = null;
        for (const call of agentCalls) {
          const hay = call.prompt.slice(0, 80).toLowerCase();
          if (hay === needle || needle.startsWith(hay.slice(0, 50)) || hay.startsWith(needle.slice(0, 50))) {
            matchedCall = call; break;
          }
        }
        if (!matchedCall) continue;

        matchedToolUseIds.add(matchedCall.toolUseId);
        const childMeta    = parseTranscriptMeta(childPath);
        const childStats   = parseTranscriptStats(childPath);
        const childCompacts = parseTranscriptCompactions(childPath);
        const label = (matchedCall.description || matchedCall.prompt).replace(/\s+/g, ' ').slice(0, 50);
        const isWorktree = matchedCall.isolation === 'worktree';

        const childNode = {
          sessionId:       childId,
          parentSessionId: node.sessionId,
          label,
          status:          'done',
          startedAt:       startedAt  || node.startedAt,
          endedAt:         endedAt    || Date.now(),
          tokens:          { input: childStats.inputTokens, output: childStats.outputTokens, cacheRead: childStats.cacheReadTokens },
          costUsd:         childStats.costUsd,
          lastText:        '',
          cwd:             childCwd   || node.cwd,
          permissionMode:  childMeta?.permissionMode || null,
          entrypoint:      childMeta?.entrypoint     || null,
          version:         childMeta?.version        || null,
          gitBranch:       childMeta?.gitBranch      || null,
          packageJson:     null,
          toolCalls:       [],
          compactions:     childCompacts,
          children:        [],
          isWorktree,
          isSidechain:     false,
        };
        sessions.set(childId, childNode);
        knownIds.add(childId);
        if (!node.children.includes(childId)) node.children.push(childId);
        persistSession(childNode);
        for (const c of childCompacts) persistCompaction(c, childId);
        console.log(`  Discovered ${isWorktree ? 'worktree' : 'background'} session ${childId.slice(0, 8)} → parent ${node.sessionId.slice(0, 8)}`);
      }

      for (const call of agentCalls) {
        if (matchedToolUseIds.has(call.toolUseId)) continue;
        if (call.isBackground) continue;

        const virtualId = `sc-${node.sessionId.slice(0, 8)}-${call.toolUseId.slice(-12)}`;
        if (sessions.has(virtualId)) continue;

        const resultText = agentResults.get(call.toolUseId) || '';
        const isError    = /^Error:|permission/i.test(resultText);

        const virtualNode = {
          sessionId:       virtualId,
          parentSessionId: node.sessionId,
          label:           (call.description || call.prompt).replace(/\s+/g, ' ').slice(0, 60),
          status:          isError ? 'error' : 'done',
          startedAt:       node.startedAt,
          endedAt:         node.endedAt || Date.now(),
          tokens:          { input: 0, output: 0, cacheRead: 0 },
          costUsd:         0,
          lastText:        resultText.slice(0, 300),
          cwd:             node.cwd,
          permissionMode:  null,
          entrypoint:      null,
          version:         null,
          gitBranch:       null,
          packageJson:     null,
          toolCalls:       [],
          compactions:     [],
          children:        [],
          isWorktree:      false,
          isSidechain:     true,
        };
        sessions.set(virtualId, virtualNode);
        knownIds.add(virtualId);
        if (!node.children.includes(virtualId)) node.children.push(virtualId);
        console.log(`  Synthesised sidechain ${virtualId} → parent ${node.sessionId.slice(0, 8)}`);
      }
    }
  }

  // memory eviction
  function evictOldSessions() {
    const MAX_MEMORY_SESSIONS = 200;
    if (sessions.size <= MAX_MEMORY_SESSIONS) return;
    const roots = [...sessions.values()]
      .filter(n => !n.parentSessionId && n.status !== 'running')
      .sort((a, b) => (a.endedAt || a.startedAt) - (b.endedAt || b.startedAt));
    const toEvict = roots.slice(0, sessions.size - MAX_MEMORY_SESSIONS);
    for (const node of toEvict) {
      // Evict children first
      for (const cid of node.children) sessions.delete(cid);
      sessions.delete(node.sessionId);
      const idx = sessionList.indexOf(node.sessionId);
      if (idx >= 0) sessionList.splice(idx, 1);
    }
    // Trim hook_events to 10,000 rows
    try { stmts.trimHookEvents.run(); } catch {}
  }

  function backfillSecurityTables() {
    db.prepare(`
      INSERT OR IGNORE INTO network_requests(id, session_id, tool, url, domain, flagged, started_at)
      SELECT tc.id, tc.session_id, tc.name,
        COALESCE(json_extract(tc.input_json,'$.url'), json_extract(tc.input_json,'$.query'), '') AS url,
        '' AS domain, 0 AS flagged, tc.started_at
      FROM tool_calls tc
      WHERE tc.name IN ('WebFetch','WebSearch')
        AND COALESCE(json_extract(tc.input_json,'$.url'), json_extract(tc.input_json,'$.query')) IS NOT NULL
    `).run();
    const blankNetRows = db.prepare(`SELECT id, url FROM network_requests WHERE domain = ''`).all();
    const updateNet = db.prepare(`UPDATE network_requests SET domain=@domain, flagged=@flagged WHERE id=@id`);
    for (const row of blankNetRows) {
      const { domain, flagged } = extractDomain(row.url);
      updateNet.run({ id: row.id, domain, flagged: flagged ? 1 : 0 });
    }

    db.prepare(`
      INSERT OR IGNORE INTO file_accesses(id, session_id, tool, file_path, sensitive, started_at)
      SELECT tc.id, tc.session_id, tc.name,
        COALESCE(json_extract(tc.input_json,'$.file_path'), json_extract(tc.input_json,'$.path'), '') AS file_path,
        0 AS sensitive, tc.started_at
      FROM tool_calls tc
      WHERE tc.name IN ('Read','Write','Edit')
        AND COALESCE(json_extract(tc.input_json,'$.file_path'), json_extract(tc.input_json,'$.path')) IS NOT NULL
    `).run();
    const blankFaRows = db.prepare(`SELECT id, file_path FROM file_accesses WHERE sensitive = 0 AND file_path != ''`).all();
    const updateFa = db.prepare(`UPDATE file_accesses SET sensitive=@sensitive WHERE id=@id`);
    for (const row of blankFaRows) {
      updateFa.run({ id: row.id, sensitive: SENSITIVE_RE.test(row.file_path) ? 1 : 0 });
    }

    const netCount = db.prepare(`SELECT COUNT(*) AS c FROM network_requests`).get().c;
    const faCount  = db.prepare(`SELECT COUNT(*) AS c FROM file_accesses`).get().c;
    console.log(`  Security tables: ${netCount} network requests, ${faCount} file accesses`);
  }

  // live cost refresh
  function refreshLiveCosts() {
    let changed = false;
    for (const node of sessions.values()) {
      if (node.status !== 'running') continue;
      const transcript = findTranscript(node.sessionId, node.cwd);
      if (!transcript) continue;
      try {
        const stats = parseFullSessionStats(transcript, node.sessionId);
        if (stats.costUsd !== node.costUsd || stats.inputTokens !== node.tokens.input) {
          node.tokens.input     = stats.inputTokens;
          node.tokens.output    = stats.outputTokens;
          node.tokens.cacheRead = stats.cacheReadTokens;
          node.costUsd          = stats.costUsd;
          node.isSubscription   = stats.isSubscription || false;
          persistSession(node);
          changed = true;
        }
      } catch {}
    }
    if (changed) broadcast();
  }

  // serialization
  function serializeSession(sessionId, _visited = new Set()) {
    if (_visited.has(sessionId)) return null; // cycle guard
    _visited.add(sessionId);
    const n = sessions.get(sessionId);
    if (!n) return null;
    return {
      sessionId:      n.sessionId,
      label:          n.label,
      status:         n.status,
      startedAt:      n.startedAt,
      endedAt:        n.endedAt,
      tokens:         n.tokens,
      costUsd:        n.costUsd,
      isSubscription: n.isSubscription || false,
      lastText:       n.lastText.slice(-200),
      permissionMode: n.permissionMode || null,
      entrypoint:     n.entrypoint     || null,
      version:        n.version        || null,
      gitBranch:      n.gitBranch      || null,
      cwd:            n.cwd            || null,
      compactions:    n.compactions    || [],
      isSidechain:    n.isSidechain    || false,
      isWorktree:     n.isWorktree     || false,
      toolCalls: n.toolCalls.map(tc => ({
        id: tc.id, name: tc.name, done: tc.done,
        summary: tc.summary, input: tc.input, durationMs: tc.durationMs,
        startedAt: tc.startedAt || null,
      })),
      children: n.children.map(cid => serializeSession(cid, _visited)).filter(Boolean),
    };
  }

  function serializeTree(rootId = null) {
    const roots = rootId ? [rootId] : [...sessionList].reverse();
    const serializedRoots = roots.map(id => serializeSession(id)).filter(Boolean);
    const allNodes  = [...sessions.values()];
    const rootNodes = allNodes.filter(n => !n.parentSessionId);
    const totals = {
      agents:    allNodes.length,
      tools:     allNodes.reduce((s, n) => s + n.toolCalls.length, 0),
      tokensIn:  rootNodes.reduce((s, n) => s + n.tokens.input, 0),
      tokensOut: rootNodes.reduce((s, n) => s + n.tokens.output, 0),
      cacheRead: rootNodes.reduce((s, n) => s + n.tokens.cacheRead, 0),
      cost:           rootNodes.reduce((s, n) => s + n.costUsd, 0),
      isSubscription: rootNodes.some(n => n.isSubscription),
    };
    return JSON.stringify({ roots: serializedRoots, root: serializedRoots[0] || null, totals });
  }

  // session factory
  function getOrCreate(sessionId, parentSessionId = null, label = null) {
    if (!sessions.has(sessionId)) {
      const node = {
        sessionId,
        parentSessionId,
        label:    label || `agent-${sessionId.slice(0, 8)}`,
        status:   'running',
        startedAt: Date.now(),
        endedAt:  null,
        tokens:   { input: 0, output: 0, cacheRead: 0 },
        costUsd:        0,
        isSubscription: false,
        toolCalls:   [],
        compactions: [],
        prompts:     [],
        lastText: '',
        children: [],
        cwd:            null,
        permissionMode: null,
        entrypoint:     null,
        version:        null,
        gitBranch:      null,
      };
      sessions.set(sessionId, node);
      persistSession(node);
      if (!parentSessionId) {
        sessionList.push(sessionId);
        // Cap sessionList to prevent unbounded SSE payload growth
        if (sessionList.length > 100) sessionList.splice(0, sessionList.length - 100);
      } else {
        const parent = sessions.get(parentSessionId);
        if (parent && !parent.children.includes(sessionId)) parent.children.push(sessionId);
      }
    }
    return sessions.get(sessionId);
  }

  // domain extraction for network_requests flagging
  const IMDS_HOST = '169.254.169.254';
  const INTERNAL_IP_RE = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.0\.0\.0|::1|fc00:|fd)/i;

  function extractDomain(urlStr) {
    if (!urlStr || typeof urlStr !== 'string') return { domain: '', flagged: false };
    try {
      const parsed = new URL(urlStr);
      const domain = parsed.hostname.toLowerCase();
      const flagged = domain === IMDS_HOST || domain === 'localhost'
        || domain.startsWith('127.') || INTERNAL_IP_RE.test(domain);
      return { domain, flagged };
    } catch {
      return { domain: '', flagged: false };
    }
  }

  // hook event handler
  function handleHook(ev) {
    const {
      hook_event_name: event,
      session_id:      sid,
      parent_session_id: parentSid,
      tool_name,
      tool_input,
      tool_use_id,
      agent_description,
      duration_ms,
      is_error,
      compact_summary,
      tokens_before,
      tokens_after,
    } = ev;

    if (!sid) return;

    if (event && persistHookEvent) persistHookEvent({ eventType: event, sessionId: sid, toolName: tool_name || '' });

    if (ev.permission_mode || ev.permissionMode) {
      const node = sessions.get(sid) || getOrCreate(sid, parentSid || null);
      if (!node.permissionMode) node.permissionMode = ev.permission_mode || ev.permissionMode;
    }

    if (ev.cwd) {
      const node = sessions.get(sid) || getOrCreate(sid, parentSid || null);
      if (!node.cwd) {
        node.cwd = ev.cwd;
        // Upgrade default "agent-xxxxxxxx" label using the cwd folder name
        if (node.label === `agent-${sid.slice(0, 8)}`) {
          const folder = ev.cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
          if (folder) node.label = folder;
        }
        try {
          const load = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; } };
          const ps  = load(path.join(ev.cwd, '.claude', 'settings.json'));
          const pls = load(path.join(ev.cwd, '.claude', 'settings.local.json'));
          const allow = [...(ps.permissions?.allow || []), ...(pls.permissions?.allow || [])];
          const deny  = [...(ps.permissions?.deny  || []), ...(pls.permissions?.deny  || [])];
          if (!node.permissionMode) {
            const userSettings = load(path.join(os.homedir(), '.claude', 'settings.json'));
            node.permissionMode = pls.permissions?.defaultMode
                              || ps.permissions?.defaultMode
                              || userSettings.permissions?.defaultMode
                              || 'default';
          }
          if (allow.length || deny.length) {
            node.projectAllow = [...new Set(allow)];
            node.projectDeny  = [...new Set(deny)];
          }
          try {
            const pkg = load(path.join(ev.cwd, 'package.json'));
            if (pkg.name) node.packageJson = { name: pkg.name, version: pkg.version,
              deps: pkg.dependencies || {}, devDeps: pkg.devDependencies || {} };
          } catch {}
          try {
            const reqs = fs.readFileSync(path.join(ev.cwd, 'requirements.txt'), 'utf8');
            node.requirementsTxt = reqs.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
          } catch {}
        } catch {}
        persistSession(node);
      }
    }

    switch (event) {

      case 'PreToolUse': {
        const node = getOrCreate(sid, parentSid || null);
        if (!tool_use_id || !tool_name) break;
        const tc = {
          id:        tool_use_id,
          name:      tool_name,
          input:     tool_input || {},
          summary:   summarize(tool_name, tool_input),
          done:      false,
          startedAt: Date.now(),
          durationMs: null,
          sessionId: sid,
        };
        node.toolCalls.push(tc);
        toolCallMap.set(tool_use_id, { sessionId: sid, call: tc });
        persistTool(tc);
        if (tool_name === 'WebFetch' || tool_name === 'WebSearch') {
          const rawUrl = tool_input?.url || tool_input?.query || '';
          const { domain, flagged } = extractDomain(rawUrl);
          persistNetRequest({ id: tool_use_id, sessionId: sid, tool: tool_name, url: rawUrl, domain, flagged });
        }
        if (tool_name === 'Read' || tool_name === 'Write' || tool_name === 'Edit') {
          const filePath = tool_input?.file_path || tool_input?.path || '';
          persistFileAccess({ id: tool_use_id, sessionId: sid, tool: tool_name, filePath,
            sensitive: filePath ? SENSITIVE_RE.test(filePath) : false });
        }
        if ((tool_name === 'Agent' || tool_name === 'Task') && agent_description) {
          const childId = `child-${tool_use_id}`;
          getOrCreate(childId, sid, agent_description);
          tc.childSessionId = childId;
        }
        break;
      }

      case 'PostToolUse': {
        const entry = toolCallMap.get(tool_use_id);
        if (entry) {
          entry.call.done      = true;
          entry.call.durationMs = duration_ms || (Date.now() - entry.call.startedAt);
          persistTool(entry.call);
          toolCallMap.delete(tool_use_id);
          persistPermDecision({ id: tool_use_id, sessionId: sid,
            toolName: entry.call.name, summary: entry.call.summary, decision: 'allowed' });
        }
        const node = sessions.get(sid);
        if (node) {
          node._toolsSinceRefresh = (node._toolsSinceRefresh || 0) + 1;
          if (node._toolsSinceRefresh >= 5) {
            node._toolsSinceRefresh = 0;
            const transcript = findTranscript(sid, node.cwd);
            if (transcript) {
              try {
                const stats = parseFullSessionStats(transcript, sid);
                node.tokens.input     = stats.inputTokens;
                node.tokens.output    = stats.outputTokens;
                node.tokens.cacheRead = stats.cacheReadTokens;
                node.costUsd          = stats.costUsd;
                node.isSubscription   = stats.isSubscription || false;
                persistSession(node);
              } catch {}
            }
          }
        }
        break;
      }

      case 'Stop': {
        const node = sessions.get(sid);
        if (node) {
          node.status  = is_error ? 'error' : 'done';
          node.endedAt = Date.now();
          node.lastText = '';
          for (const tc of node.toolCalls) {
            if (!tc.done) {
              tc.done = true; tc.durationMs = Date.now() - tc.startedAt; persistTool(tc);
              persistPermDecision({ id: tc.id, sessionId: sid, toolName: tc.name, summary: tc.summary, decision: 'blocked' });
            }
            if (tc.id && toolCallMap.has(tc.id)) toolCallMap.delete(tc.id);
          }
          const transcript = findTranscript(sid, node.cwd);
          if (transcript) {
            try {
              const tmeta = parseTranscriptMeta(transcript);
              if (tmeta.permissionMode) node.permissionMode = tmeta.permissionMode;
              if (tmeta.entrypoint)     node.entrypoint     = tmeta.entrypoint;
              if (tmeta.version)        node.version        = tmeta.version;
              if (tmeta.gitBranch)      node.gitBranch      = tmeta.gitBranch;
              if (tmeta.label) {
                const cwdFolderStop = node.cwd ? node.cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() : null;
                const isPlaceholderLabel = node.label === `agent-${sid.slice(0, 8)}` || node.label === cwdFolderStop;
                if (isPlaceholderLabel) node.label = tmeta.label;
              }
              const stats = parseFullSessionStats(transcript, sid);
              node.tokens.input     = stats.inputTokens;
              node.tokens.output    = stats.outputTokens;
              node.tokens.cacheRead = stats.cacheReadTokens;
              node.costUsd          = stats.costUsd;
              node.isSubscription   = stats.isSubscription || false;
            } catch {}
          }
          persistSession(node);
        }
        break;
      }

      case 'PreCompact': {
        const node = getOrCreate(sid, parentSid || null);
        const seq = tool_use_id || ++compactSeq;
        const cid = `compact-${sid}-${seq}`;
        if (!node.compactions.find(x => x.id === cid)) {
          const c = {
            id:           cid,
            timestamp:    Date.now(),
            summary:      '',
            tokensBefore: tokens_before || ev.input_tokens_before || null,
            tokensAfter:  null,
            _toolUseId:   tool_use_id || null,
            _seq:         seq, // store seq so PostCompact can match without tool_use_id
          };
          node.compactions.push(c);
          persistCompaction(c, sid);
        }
        break;
      }

      case 'PostCompact': {
        const node = sessions.get(sid);
        if (!node) break;
        // Match by tool_use_id first, then by most recent unfinished compaction
        const existing = node.compactions.find(x =>
          (tool_use_id && x._toolUseId === tool_use_id)
        ) || (!tool_use_id ? node.compactions.findLast(x => x.tokensAfter === null && x.summary === '') : null);
        if (existing) {
          existing.summary      = compact_summary || ev.summary || '';
          existing.tokensAfter  = tokens_after  || ev.input_tokens_after  || null;
          existing.tokensBefore = existing.tokensBefore || tokens_before || null;
          persistCompaction(existing, sid);
        } else {
          const c = {
            id:           `compact-${sid}-${tool_use_id || ++compactSeq}`,
            timestamp:    Date.now(),
            summary:      compact_summary || ev.summary || '',
            tokensBefore: tokens_before || null,
            tokensAfter:  tokens_after  || null,
          };
          if (!node.compactions.find(x => x.id === c.id)) {
            node.compactions.push(c);
            persistCompaction(c, sid);
          }
        }
        persistSession(node);
        break;
      }

      case 'SessionStart': {
        getOrCreate(sid, parentSid || null);
        break;
      }

      case 'UserPromptSubmit': {
        const node = getOrCreate(sid, parentSid || null);
        const text = ev.prompt || ev.user_prompt || '';
        if (text) {
          node.prompts = node.prompts || [];
          node.prompts.push({ timestamp: Date.now(), text: String(text).slice(0, 2000) });
        }
        break;
      }

      case 'SubagentStop': {
        const node = sessions.get(sid);
        if (node) {
          node.status  = is_error ? 'error' : 'done';
          node.endedAt = Date.now();
          for (const tc of node.toolCalls) {
            if (!tc.done) { tc.done = true; tc.durationMs = Date.now() - tc.startedAt; persistTool(tc); }
          }
          persistSession(node);
        }
        break;
      }

      case 'PostToolUseFailure': {
        const entry = toolCallMap.get(tool_use_id);
        if (entry) {
          entry.call.done       = true;
          entry.call.error      = true;
          entry.call.durationMs = duration_ms || (Date.now() - entry.call.startedAt);
          persistTool(entry.call);
          toolCallMap.delete(tool_use_id);
          persistPermDecision({ id: tool_use_id, sessionId: sid,
            toolName: entry.call.name, summary: entry.call.summary, decision: 'error' });
        }
        break;
      }

      case 'SessionEnd': {
        const node = sessions.get(sid);
        if (node) {
          if (node.status === 'running') node.status = 'done';
          node.endedAt = node.endedAt || Date.now();
          // Clean up any pending tool calls (same as Stop handler)
          for (const tc of node.toolCalls) {
            if (!tc.done) { tc.done = true; tc.durationMs = Date.now() - tc.startedAt; persistTool(tc); }
            if (tc.id && toolCallMap.has(tc.id)) toolCallMap.delete(tc.id);
          }
          persistSession(node);
        }
        break;
      }

      default: {
        if (event) console.warn(`[hook] unknown event: ${event}`);
        break;
      }
    }

    broadcast();
  }

  return {
    sessions, toolCallMap, sessionList, clients,
    loadHistory, loadSessionTree,
    backfillCosts, discoverChildSessions, refreshLiveCosts, evictOldSessions, backfillSecurityTables,
    serializeSession, serializeTree, broadcast,
    getOrCreate, handleHook,
    renameSession,
  };

  function renameSession(sessionId, newLabel) {
    const node = sessions.get(sessionId) || loadSessionTree(sessionId);
    if (!node) return false;
    const trimmed = String(newLabel || '').trim().slice(0, 200);
    if (!trimmed) return false;
    node.label = trimmed;
    persistSession(node);
    broadcast();
    return true;
  }
}

module.exports = { createStore };
