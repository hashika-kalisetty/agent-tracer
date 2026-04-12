// spawns the daemon with a temp DB, sends real HTTP requests, asserts via /api/sessions

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'child_process';
import http from 'http';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// helpers

const TEST_PORT = 14243;
const TEST_UUID = '550e8400-e29b-41d4-a716-446655440001';
const TEST_TOOL_ID = 'toolu_test_001';

function post(port, pathname, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const options = {
      hostname: '127.0.0.1',
      port,
      path: pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    };
    const req = http.request(options, (res) => {
      let text = '';
      res.on('data', d => { text += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: text }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function get(port, pathname) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port, path: pathname }, (res) => {
      let text = '';
      res.on('data', d => { text += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: text }));
    }).on('error', reject);
  });
}

function waitForServer(port, retries = 80, interval = 150) {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const check = () => {
      const req = http.request({ hostname: '127.0.0.1', port, path: '/api/sessions', method: 'GET' }, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => {
        if (++attempts >= retries) return reject(new Error(`daemon not ready on port ${port}`));
        setTimeout(check, interval);
      });
      req.end();
    };
    check();
  });
}

// daemon lifecycle

let daemonProc;
let tmpDir;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tracer-test-'));
  const dbPath = path.join(tmpDir, 'test.db');

  daemonProc = spawn(process.execPath, [
    path.join(__dirname, '../bin/agent-tracer-daemon.js'),
  ], {
    env: {
      ...process.env,
      PORT: String(TEST_PORT),
      AGENT_TRACER_DB: dbPath,
      AGENT_TRACE_TEST: '1',   // signal to daemon to skip loadHistory side-effects (optional)
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  daemonProc.stdout.on('data', () => {}); // drain
  daemonProc.stderr.on('data', () => {});
  daemonProc.on('error', (err) => { throw err; });

  await waitForServer(TEST_PORT);
}, 15000);

afterAll(async () => {
  if (daemonProc) {
    daemonProc.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 300));
  }
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

// tests

describe('/hook endpoint — PreToolUse', () => {
  it('creates a session and a pending tool call', async () => {
    const resp = await post(TEST_PORT, '/hook', {
      hook_event_name: 'PreToolUse',
      session_id: TEST_UUID,
      tool_name: 'Read',
      tool_use_id: TEST_TOOL_ID,
      tool_input: { file_path: '/tmp/test.txt' },
    });

    expect(resp.status).toBe(200);
    expect(JSON.parse(resp.body).ok).toBe(true);

    // Check session created
    const sessionResp = await get(TEST_PORT, `/api/sessions/${TEST_UUID}`);
    expect(sessionResp.status).toBe(200);
    const session = JSON.parse(sessionResp.body);
    expect(session.sessionId).toBe(TEST_UUID);
    expect(session.status).toBe('running');

    // Tool call should exist and be pending (done=false)
    const tool = session.toolCalls.find(t => t.id === TEST_TOOL_ID);
    expect(tool).toBeTruthy();
    expect(tool.done).toBe(false);
    expect(tool.name).toBe('Read');
    expect(tool.summary).toBe('/tmp/test.txt');
  });
});

describe('/hook endpoint — PostToolUse', () => {
  it('marks the tool as done with durationMs', async () => {
    // Send PostToolUse for the tool we created above
    await new Promise(r => setTimeout(r, 50)); // small delay to ensure durationMs > 0
    const resp = await post(TEST_PORT, '/hook', {
      hook_event_name: 'PostToolUse',
      session_id: TEST_UUID,
      tool_use_id: TEST_TOOL_ID,
      duration_ms: 42,
    });

    expect(resp.status).toBe(200);

    const sessionResp = await get(TEST_PORT, `/api/sessions/${TEST_UUID}`);
    const session = JSON.parse(sessionResp.body);
    const tool = session.toolCalls.find(t => t.id === TEST_TOOL_ID);
    expect(tool).toBeTruthy();
    expect(tool.done).toBe(true);
    expect(tool.durationMs).toBe(42);
  });
});

describe('/hook endpoint — Stop', () => {
  const STOP_UUID = '550e8400-e29b-41d4-a716-446655440002';
  const PENDING_TOOL = 'toolu_pending_001';

  it('marks session as done and all pending tools done', async () => {
    // Create session with one pending tool
    await post(TEST_PORT, '/hook', {
      hook_event_name: 'PreToolUse',
      session_id: STOP_UUID,
      tool_name: 'Bash',
      tool_use_id: PENDING_TOOL,
      tool_input: { command: 'ls -la' },
    });

    // Stop the session
    const resp = await post(TEST_PORT, '/hook', {
      hook_event_name: 'Stop',
      session_id: STOP_UUID,
    });
    expect(resp.status).toBe(200);

    const sessionResp = await get(TEST_PORT, `/api/sessions/${STOP_UUID}`);
    const session = JSON.parse(sessionResp.body);
    expect(session.status).toBe('done');

    // Pending tool should now be done
    const tool = session.toolCalls.find(t => t.id === PENDING_TOOL);
    expect(tool).toBeTruthy();
    expect(tool.done).toBe(true);
  });

  it('marks session as error when is_error=true', async () => {
    const errUUID = '550e8400-e29b-41d4-a716-446655440007';
    await post(TEST_PORT, '/hook', {
      hook_event_name: 'PreToolUse',
      session_id: errUUID,
      tool_name: 'Bash',
      tool_use_id: 'toolu_err_001',
      tool_input: { command: 'false' },
    });
    await post(TEST_PORT, '/hook', {
      hook_event_name: 'Stop',
      session_id: errUUID,
      is_error: true,
    });

    const sessionResp = await get(TEST_PORT, `/api/sessions/${errUUID}`);
    const session = JSON.parse(sessionResp.body);
    expect(session.status).toBe('error');
  });
});

describe('/hook endpoint — PreCompact / PostCompact', () => {
  const COMPACT_UUID = '550e8400-e29b-41d4-a716-446655440003';
  const COMPACT_TOOL_ID = 'toolu_compact_001';

  it('creates a compaction entry on PreCompact', async () => {
    await post(TEST_PORT, '/hook', {
      hook_event_name: 'PreToolUse',
      session_id: COMPACT_UUID,
      tool_name: 'Read',
      tool_use_id: 'toolu_read_compact',
      tool_input: { file_path: '/tmp/x' },
    });

    const resp = await post(TEST_PORT, '/hook', {
      hook_event_name: 'PreCompact',
      session_id: COMPACT_UUID,
      tool_use_id: COMPACT_TOOL_ID,
      tokens_before: 80000,
    });
    expect(resp.status).toBe(200);

    const sessionResp = await get(TEST_PORT, `/api/sessions/${COMPACT_UUID}`);
    const session = JSON.parse(sessionResp.body);
    expect(session.compactions).toHaveLength(1);
    expect(session.compactions[0].tokensBefore).toBe(80000);
  });

  it('updates compaction on PostCompact with summary and tokensAfter', async () => {
    const resp = await post(TEST_PORT, '/hook', {
      hook_event_name: 'PostCompact',
      session_id: COMPACT_UUID,
      tool_use_id: COMPACT_TOOL_ID,
      compact_summary: 'Compacted the context window.',
      tokens_after: 5000,
    });
    expect(resp.status).toBe(200);

    const sessionResp = await get(TEST_PORT, `/api/sessions/${COMPACT_UUID}`);
    const session = JSON.parse(sessionResp.body);
    expect(session.compactions[0].summary).toBe('Compacted the context window.');
    expect(session.compactions[0].tokensAfter).toBe(5000);
  });
});

describe('/hook endpoint — invalid session_id', () => {
  it('returns 400 for a non-UUID session_id', async () => {
    const resp = await post(TEST_PORT, '/hook', {
      hook_event_name: 'PreToolUse',
      session_id: 'not-a-uuid',
      tool_name: 'Read',
      tool_use_id: 'toolu_bad_001',
      tool_input: { file_path: '/tmp/x' },
    });
    expect(resp.status).toBe(400);
  });

  it('returns 400 for a path-like session_id', async () => {
    const resp = await post(TEST_PORT, '/hook', {
      hook_event_name: 'PreToolUse',
      session_id: '../../../etc/passwd',
      tool_name: 'Read',
      tool_use_id: 'toolu_bad_002',
      tool_input: {},
    });
    expect(resp.status).toBe(400);
  });

  it('returns 400 for malformed JSON body', async () => {
    // Send raw malformed JSON
    const resp = await new Promise((resolve, reject) => {
      const data = 'not-json{{{';
      const options = {
        hostname: '127.0.0.1',
        port: TEST_PORT,
        path: '/hook',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      };
      const req = http.request(options, (res) => {
        let text = '';
        res.on('data', d => { text += d; });
        res.on('end', () => resolve({ status: res.statusCode, body: text }));
      });
      req.on('error', reject);
      req.write(data);
      req.end();
    });
    expect(resp.status).toBe(400);
  });
});

describe('/hook endpoint — tool summary via summarize()', () => {
  const SUM_UUID = '550e8400-e29b-41d4-a716-446655440004';

  it('Bash tool summary is the command (truncated at 80)', async () => {
    await post(TEST_PORT, '/hook', {
      hook_event_name: 'PreToolUse',
      session_id: SUM_UUID,
      tool_name: 'Bash',
      tool_use_id: 'toolu_bash_sum',
      tool_input: { command: 'npm test --reporter verbose' },
    });

    const sessionResp = await get(TEST_PORT, `/api/sessions/${SUM_UUID}`);
    const session = JSON.parse(sessionResp.body);
    const tool = session.toolCalls.find(t => t.id === 'toolu_bash_sum');
    expect(tool.summary).toBe('npm test --reporter verbose');
  });

  it('Grep tool summary wraps pattern in quotes', async () => {
    await post(TEST_PORT, '/hook', {
      hook_event_name: 'PreToolUse',
      session_id: SUM_UUID,
      tool_name: 'Grep',
      tool_use_id: 'toolu_grep_sum',
      tool_input: { pattern: 'isValidSessionId' },
    });

    const sessionResp = await get(TEST_PORT, `/api/sessions/${SUM_UUID}`);
    const session = JSON.parse(sessionResp.body);
    const tool = session.toolCalls.find(t => t.id === 'toolu_grep_sum');
    expect(tool.summary).toBe('"isValidSessionId"');
  });
});

describe('/hook endpoint — multiple tools in sequence', () => {
  const SEQ_UUID = '550e8400-e29b-41d4-a716-446655440005';

  it('accumulates multiple tool calls in the session', async () => {
    const tools = [
      { id: 'toolu_seq_1', name: 'Read',  input: { file_path: '/a' } },
      { id: 'toolu_seq_2', name: 'Write', input: { file_path: '/b', content: 'x' } },
      { id: 'toolu_seq_3', name: 'Bash',  input: { command: 'echo hi' } },
    ];

    for (const t of tools) {
      await post(TEST_PORT, '/hook', {
        hook_event_name: 'PreToolUse',
        session_id: SEQ_UUID,
        tool_name: t.name,
        tool_use_id: t.id,
        tool_input: t.input,
      });
    }

    const sessionResp = await get(TEST_PORT, `/api/sessions/${SEQ_UUID}`);
    const session = JSON.parse(sessionResp.body);
    expect(session.toolCalls).toHaveLength(3);
    expect(session.toolCalls.every(t => !t.done)).toBe(true);
  });
});

describe('/hook endpoint — cwd validation', () => {
  const CWD_UUID = '550e8400-e29b-41d4-a716-446655440006';

  it('strips cwd with path traversal before storing', async () => {
    await post(TEST_PORT, '/hook', {
      hook_event_name: 'PreToolUse',
      session_id: CWD_UUID,
      tool_name: 'Read',
      tool_use_id: 'toolu_cwd_001',
      tool_input: { file_path: '/tmp/x' },
      cwd: '../../etc',  // relative with traversal — should be stripped
    });

    const sessionResp = await get(TEST_PORT, `/api/sessions/${CWD_UUID}`);
    const session = JSON.parse(sessionResp.body);
    // cwd with '..' or non-absolute should have been deleted from event
    // The session should exist but cwd should be null (stripped)
    expect(session.cwd).toBeNull();
  });
});

describe('/api/sessions endpoint', () => {
  it('returns an array of sessions', async () => {
    const resp = await get(TEST_PORT, '/api/sessions');
    expect(resp.status).toBe(200);
    const sessions = JSON.parse(resp.body);
    expect(Array.isArray(sessions)).toBe(true);
  });
});

// new hook events

describe('/hook endpoint — SessionStart', () => {
  const SS_UUID = '550e8400-e29b-41d4-a716-446655440010';

  it('creates a session on SessionStart', async () => {
    const resp = await post(TEST_PORT, '/hook', {
      hook_event_name: 'SessionStart',
      session_id: SS_UUID,
    });
    expect(resp.status).toBe(200);

    const sessionResp = await get(TEST_PORT, `/api/sessions/${SS_UUID}`);
    expect(sessionResp.status).toBe(200);
    const session = JSON.parse(sessionResp.body);
    expect(session.sessionId).toBe(SS_UUID);
    expect(session.status).toBe('running');
  });
});

describe('/hook endpoint — SessionEnd', () => {
  const SE_UUID = '550e8400-e29b-41d4-a716-446655440011';

  it('marks a running session as done', async () => {
    await post(TEST_PORT, '/hook', { hook_event_name: 'SessionStart', session_id: SE_UUID });
    const resp = await post(TEST_PORT, '/hook', { hook_event_name: 'SessionEnd', session_id: SE_UUID });
    expect(resp.status).toBe(200);

    const sessionResp = await get(TEST_PORT, `/api/sessions/${SE_UUID}`);
    const session = JSON.parse(sessionResp.body);
    expect(session.status).toBe('done');
    expect(session.endedAt).toBeTruthy();
  });

  it('does not overwrite an already-ended session status', async () => {
    // Session was already ended above — sending SessionEnd again should still be 'done'
    await post(TEST_PORT, '/hook', { hook_event_name: 'SessionEnd', session_id: SE_UUID });
    const sessionResp = await get(TEST_PORT, `/api/sessions/${SE_UUID}`);
    const session = JSON.parse(sessionResp.body);
    expect(session.status).toBe('done');
  });
});

describe('/hook endpoint — UserPromptSubmit', () => {
  const UP_UUID = '550e8400-e29b-41d4-a716-446655440012';

  it('creates session and stores prompt', async () => {
    const resp = await post(TEST_PORT, '/hook', {
      hook_event_name: 'UserPromptSubmit',
      session_id: UP_UUID,
      prompt: 'Fix the login bug',
    });
    expect(resp.status).toBe(200);

    const sessionResp = await get(TEST_PORT, `/api/sessions/${UP_UUID}`);
    expect(sessionResp.status).toBe(200);
    const session = JSON.parse(sessionResp.body);
    expect(session.sessionId).toBe(UP_UUID);
  });
});

describe('/hook endpoint — SubagentStop', () => {
  const SA_UUID = '550e8400-e29b-41d4-a716-446655440013';
  const SA_TOOL = 'toolu_subagent_001';

  it('marks session and pending tools as done', async () => {
    await post(TEST_PORT, '/hook', {
      hook_event_name: 'PreToolUse',
      session_id: SA_UUID,
      tool_name: 'Read',
      tool_use_id: SA_TOOL,
      tool_input: { file_path: '/tmp/x' },
    });

    const resp = await post(TEST_PORT, '/hook', {
      hook_event_name: 'SubagentStop',
      session_id: SA_UUID,
    });
    expect(resp.status).toBe(200);

    const sessionResp = await get(TEST_PORT, `/api/sessions/${SA_UUID}`);
    const session = JSON.parse(sessionResp.body);
    expect(session.status).toBe('done');
    const tool = session.toolCalls.find(t => t.id === SA_TOOL);
    expect(tool.done).toBe(true);
  });

  it('marks as error when is_error=true', async () => {
    const ERR_UUID = '550e8400-e29b-41d4-a716-446655440014';
    await post(TEST_PORT, '/hook', {
      hook_event_name: 'SessionStart',
      session_id: ERR_UUID,
    });
    await post(TEST_PORT, '/hook', {
      hook_event_name: 'SubagentStop',
      session_id: ERR_UUID,
      is_error: true,
    });

    const sessionResp = await get(TEST_PORT, `/api/sessions/${ERR_UUID}`);
    const session = JSON.parse(sessionResp.body);
    expect(session.status).toBe('error');
  });
});

describe('/hook endpoint — PostToolUseFailure', () => {
  const PF_UUID = '550e8400-e29b-41d4-a716-446655440015';
  const PF_TOOL = 'toolu_fail_001';

  it('marks tool as done with error flag', async () => {
    await post(TEST_PORT, '/hook', {
      hook_event_name: 'PreToolUse',
      session_id: PF_UUID,
      tool_name: 'Bash',
      tool_use_id: PF_TOOL,
      tool_input: { command: 'exit 1' },
    });

    const resp = await post(TEST_PORT, '/hook', {
      hook_event_name: 'PostToolUseFailure',
      session_id: PF_UUID,
      tool_use_id: PF_TOOL,
      duration_ms: 100,
    });
    expect(resp.status).toBe(200);

    const sessionResp = await get(TEST_PORT, `/api/sessions/${PF_UUID}`);
    const session = JSON.parse(sessionResp.body);
    const tool = session.toolCalls.find(t => t.id === PF_TOOL);
    expect(tool.done).toBe(true);
    expect(tool.durationMs).toBe(100);
  });
});

// rename endpoint

describe('/api/sessions/:id/rename', () => {
  const RN_UUID = '550e8400-e29b-41d4-a716-446655440016';

  it('renames a session', async () => {
    await post(TEST_PORT, '/hook', {
      hook_event_name: 'SessionStart',
      session_id: RN_UUID,
    });

    const resp = await post(TEST_PORT, `/api/sessions/${RN_UUID}/rename`, {
      label: 'My Custom Name',
    });
    expect(resp.status).toBe(200);
    expect(JSON.parse(resp.body).ok).toBe(true);

    const sessionResp = await get(TEST_PORT, `/api/sessions/${RN_UUID}`);
    const session = JSON.parse(sessionResp.body);
    expect(session.label).toBe('My Custom Name');
  });

  it('returns 400 for empty label', async () => {
    const resp = await post(TEST_PORT, `/api/sessions/${RN_UUID}/rename`, {
      label: '   ',
    });
    expect(resp.status).toBe(400);
  });

  it('returns 400 for invalid session ID', async () => {
    const resp = await post(TEST_PORT, '/api/sessions/not-a-uuid/rename', {
      label: 'test',
    });
    expect(resp.status).toBe(400);
  });
});

// permission mode capture

describe('/hook endpoint — permission mode and cwd', () => {
  const PM_UUID = '550e8400-e29b-41d4-a716-446655440017';

  it('captures permission_mode from hook event', async () => {
    await post(TEST_PORT, '/hook', {
      hook_event_name: 'PreToolUse',
      session_id: PM_UUID,
      tool_name: 'Read',
      tool_use_id: 'toolu_pm_001',
      tool_input: { file_path: '/tmp/x' },
      permission_mode: 'bypassPermissions',
    });

    const sessionResp = await get(TEST_PORT, `/api/sessions/${PM_UUID}`);
    const session = JSON.parse(sessionResp.body);
    expect(session.permissionMode).toBe('bypassPermissions');
  });

  it('captures cwd and upgrades default label to folder name', async () => {
    const CWD2_UUID = '550e8400-e29b-41d4-a716-446655440018';
    await post(TEST_PORT, '/hook', {
      hook_event_name: 'PreToolUse',
      session_id: CWD2_UUID,
      tool_name: 'Read',
      tool_use_id: 'toolu_cwd_002',
      tool_input: { file_path: '/tmp/x' },
      cwd: '/Users/test/my-cool-project',
    });

    const sessionResp = await get(TEST_PORT, `/api/sessions/${CWD2_UUID}`);
    const session = JSON.parse(sessionResp.body);
    expect(session.cwd).toBe('/Users/test/my-cool-project');
    // Default label should be upgraded from "agent-550e8400" to folder name
    expect(session.label).toBe('my-cool-project');
  });
});

// parent-child sessions

describe('/hook endpoint — parent-child sessions', () => {
  const PARENT_UUID = '550e8400-e29b-41d4-a716-446655440019';
  const CHILD_UUID  = '550e8400-e29b-41d4-a716-446655440020';

  it('creates parent and child with correct linkage', async () => {
    await post(TEST_PORT, '/hook', {
      hook_event_name: 'SessionStart',
      session_id: PARENT_UUID,
    });
    await post(TEST_PORT, '/hook', {
      hook_event_name: 'SessionStart',
      session_id: CHILD_UUID,
      parent_session_id: PARENT_UUID,
    });

    const parentResp = await get(TEST_PORT, `/api/sessions/${PARENT_UUID}`);
    const parent = JSON.parse(parentResp.body);
    expect(parent.children.some(c => c.sessionId === CHILD_UUID)).toBe(true);

    const childResp = await get(TEST_PORT, `/api/sessions/${CHILD_UUID}`);
    const child = JSON.parse(childResp.body);
    expect(child.sessionId).toBe(CHILD_UUID);
  });
});

// api endpoints

describe('/api/permissions endpoint', () => {
  it('returns permission data with expected fields', async () => {
    const resp = await get(TEST_PORT, '/api/permissions');
    expect(resp.status).toBe(200);
    const data = JSON.parse(resp.body);
    expect(data).toHaveProperty('defaultMode');
    expect(data).toHaveProperty('allow');
    expect(data).toHaveProperty('deny');
    expect(data).toHaveProperty('toolStats');
    expect(Array.isArray(data.allow)).toBe(true);
    expect(Array.isArray(data.toolStats)).toBe(true);
  });

  it('toolStats includes tools used in tests', async () => {
    const resp = await get(TEST_PORT, '/api/permissions');
    const data = JSON.parse(resp.body);
    const readStat = data.toolStats.find(t => t.name === 'Read');
    expect(readStat).toBeTruthy();
    expect(readStat.calls).toBeGreaterThan(0);
  });
});

describe('/api/security-audit endpoint', () => {
  it('returns audit data with expected fields', async () => {
    const resp = await get(TEST_PORT, '/api/security-audit');
    expect(resp.status).toBe(200);
    const data = JSON.parse(resp.body);
    expect(data).toHaveProperty('hooks');
    expect(data).toHaveProperty('bashCommands');
    expect(data).toHaveProperty('sensitiveFiles');
    expect(data).toHaveProperty('webRequests');
    expect(data).toHaveProperty('bypassSessions');
    expect(data).toHaveProperty('blockedActions');
    expect(Array.isArray(data.hooks)).toBe(true);
  });

  it('bashCommands includes Bash tool calls from earlier tests', async () => {
    const resp = await get(TEST_PORT, '/api/security-audit');
    const data = JSON.parse(resp.body);
    const lsCmd = data.bashCommands.find(b => b.command === 'ls -la');
    expect(lsCmd).toBeTruthy();
  });
});

describe('/api/packages endpoint', () => {
  it('returns package data', async () => {
    const resp = await get(TEST_PORT, '/api/packages');
    expect(resp.status).toBe(200);
    const data = JSON.parse(resp.body);
    expect(data).toHaveProperty('cwd');
    expect(data).toHaveProperty('npm');
    expect(data).toHaveProperty('pip');
  });
});

describe('/api/projects endpoint', () => {
  it('returns project data grouped by cwd', async () => {
    const resp = await get(TEST_PORT, '/api/projects');
    expect(resp.status).toBe(200);
    const data = JSON.parse(resp.body);
    expect(Array.isArray(data)).toBe(true);
  });
});

describe('/health endpoint', () => {
  it('returns ok and session count', async () => {
    const resp = await get(TEST_PORT, '/health');
    expect(resp.status).toBe(200);
    const data = JSON.parse(resp.body);
    expect(data.ok).toBe(true);
    expect(typeof data.sessions).toBe('number');
    expect(data.sessions).toBeGreaterThan(0);
  });
});

describe('SSE /events endpoint', () => {
  it('sends initial state on connect', async () => {
    const data = await new Promise((resolve, reject) => {
      http.get({ hostname: '127.0.0.1', port: TEST_PORT, path: '/events' }, (res) => {
        let buf = '';
        res.on('data', d => {
          buf += d;
          if (buf.includes('\n\n')) {
            res.destroy();
            resolve(buf);
          }
        });
        setTimeout(() => { res.destroy(); reject(new Error('timeout')); }, 3000);
      }).on('error', reject);
    });
    expect(data).toContain('data: ');
    const jsonStr = data.split('data: ')[1].split('\n')[0];
    const msg = JSON.parse(jsonStr);
    expect(msg).toHaveProperty('roots');
    expect(msg).toHaveProperty('totals');
    expect(msg.totals).toHaveProperty('agents');
    expect(msg.totals).toHaveProperty('cost');
  });
});

describe('/hook endpoint — oversized payload', () => {
  it('returns 413 for body over 1 MB', async () => {
    const data = JSON.stringify({ hook_event_name: 'PreToolUse', session_id: TEST_UUID, payload: 'x'.repeat(1_100_000) });
    const resp = await new Promise((resolve, reject) => {
      const options = {
        hostname: '127.0.0.1', port: TEST_PORT, path: '/hook', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      };
      const req = http.request(options, (res) => {
        res.resume();
        resolve({ status: res.statusCode });
      });
      req.on('error', reject);
      req.write(data);
      req.end();
    });
    expect(resp.status).toBe(413);
  });
});

describe('CORS', () => {
  it('blocks requests from non-localhost origins with 403', async () => {
    const resp = await new Promise((resolve, reject) => {
      const options = {
        hostname: '127.0.0.1', port: TEST_PORT, path: '/api/sessions', method: 'GET',
        headers: { Origin: 'https://evil.example.com' },
      };
      http.request(options, (res) => {
        res.resume();
        resolve({ status: res.statusCode });
      }).on('error', reject).end();
    });
    expect(resp.status).toBe(403);
  });

  it('allows requests from localhost origin', async () => {
    const resp = await new Promise((resolve, reject) => {
      const options = {
        hostname: '127.0.0.1', port: TEST_PORT, path: '/api/sessions', method: 'GET',
        headers: { Origin: `http://localhost:${TEST_PORT}` },
      };
      http.request(options, (res) => {
        res.resume();
        resolve({ status: res.statusCode });
      }).on('error', reject).end();
    });
    expect(resp.status).toBe(200);
  });

  it('OPTIONS preflight returns 204 with CORS headers', async () => {
    const resp = await new Promise((resolve, reject) => {
      const options = {
        hostname: '127.0.0.1', port: TEST_PORT, path: '/hook', method: 'OPTIONS',
        headers: { Origin: `http://localhost:${TEST_PORT}` },
      };
      http.request(options, (res) => {
        res.resume();
        resolve({ status: res.statusCode, headers: res.headers });
      }).on('error', reject).end();
    });
    expect(resp.status).toBe(204);
    expect(resp.headers['access-control-allow-methods']).toContain('POST');
  });
});

describe('404 route', () => {
  it('returns 404 for unknown paths', async () => {
    const resp = await get(TEST_PORT, '/nonexistent-route');
    expect(resp.status).toBe(404);
  });
});

describe('/api/sessions/:id/thread endpoint', () => {
  it('returns 404 when no transcript file exists for the session', async () => {
    const NO_TRANSCRIPT_UUID = '550e8400-e29b-41d4-a716-446655440099';
    await post(TEST_PORT, '/hook', { hook_event_name: 'SessionStart', session_id: NO_TRANSCRIPT_UUID });
    const resp = await get(TEST_PORT, `/api/sessions/${NO_TRANSCRIPT_UUID}/thread`);
    expect(resp.status).toBe(404);
  });
});

describe('/api/sessions/:id/rename — oversized body', () => {
  const RN2_UUID = '550e8400-e29b-41d4-a716-446655440030';

  it('returns 413 for rename body over 4096 bytes', async () => {
    await post(TEST_PORT, '/hook', { hook_event_name: 'SessionStart', session_id: RN2_UUID });
    const data = JSON.stringify({ label: 'x'.repeat(5000) });
    const resp = await new Promise((resolve, reject) => {
      const options = {
        hostname: '127.0.0.1', port: TEST_PORT,
        path: `/api/sessions/${RN2_UUID}/rename`, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      };
      const req = http.request(options, (res) => {
        res.resume();
        resolve({ status: res.statusCode });
      });
      req.on('error', reject);
      req.write(data);
      req.end();
    });
    expect(resp.status).toBe(413);
  });
});
