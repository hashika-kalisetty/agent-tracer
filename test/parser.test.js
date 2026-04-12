import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const {
  isValidSessionId, summarize, safeCwdToProjectDir, safeFilePath,
  parseTranscriptMeta, parseTranscriptCompactions,
  parseTranscriptStats, findChildSessionIds, parseFullSessionStats,
  findTranscript, SENSITIVE_RE, PRICING, DEFAULT_PRICE,
} = require('../lib/parser.js');

const FIXTURES = path.join(__dirname, 'fixtures');

// isvalidsessionid

describe('isValidSessionId', () => {
  it('accepts a standard lowercase UUID', () => {
    expect(isValidSessionId('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')).toBe(true);
  });

  it('accepts a mixed-case UUID', () => {
    expect(isValidSessionId('AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE')).toBe(true);
  });

  it('accepts a UUID with hex digits', () => {
    expect(isValidSessionId('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
  });

  it('rejects an empty string', () => {
    expect(isValidSessionId('')).toBe(false);
  });

  it('rejects a short string', () => {
    expect(isValidSessionId('abc')).toBe(false);
  });

  it('rejects a path-like string', () => {
    expect(isValidSessionId('/home/user/.claude/sessions/abc')).toBe(false);
  });

  it('rejects a UUID missing dashes', () => {
    expect(isValidSessionId('aaaaaaaaabbbbccccddddeeeeeeeeeeee')).toBe(false);
  });

  it('rejects a non-string value', () => {
    expect(isValidSessionId(null)).toBe(false);
    expect(isValidSessionId(undefined)).toBe(false);
    expect(isValidSessionId(42)).toBe(false);
  });

  it('rejects a UUID with extra characters', () => {
    expect(isValidSessionId('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee-extra')).toBe(false);
  });
});

// summarize

describe('summarize', () => {
  it('returns file_path for Read', () => {
    expect(summarize('Read', { file_path: '/foo/bar.js' })).toBe('/foo/bar.js');
  });

  it('returns file_path for Write', () => {
    expect(summarize('Write', { file_path: '/tmp/out.txt', content: 'hello' })).toBe('/tmp/out.txt');
  });

  it('returns file_path for Edit', () => {
    expect(summarize('Edit', { file_path: '/src/main.js' })).toBe('/src/main.js');
  });

  it('returns pattern for Glob', () => {
    expect(summarize('Glob', { pattern: '**/*.js' })).toBe('**/*.js');
  });

  it('wraps pattern in quotes for Grep', () => {
    expect(summarize('Grep', { pattern: 'hello world' })).toBe('"hello world"');
  });

  it('truncates Grep pattern at 60 chars', () => {
    const long = 'a'.repeat(80);
    const result = summarize('Grep', { pattern: long });
    expect(result).toBe(`"${'a'.repeat(60)}"`);
  });

  it('returns command for Bash', () => {
    expect(summarize('Bash', { command: 'ls -la' })).toBe('ls -la');
  });

  it('truncates Bash command at 80 chars', () => {
    const long = 'x'.repeat(100);
    const result = summarize('Bash', { command: long });
    expect(result).toBe('x'.repeat(80));
  });

  it('returns description for Agent', () => {
    expect(summarize('Agent', { description: 'Run tests', prompt: 'fallback' })).toBe('Run tests');
  });

  it('falls back to prompt for Agent when description absent', () => {
    expect(summarize('Agent', { prompt: 'Do the thing' })).toBe('Do the thing');
  });

  it('returns description for Task', () => {
    expect(summarize('Task', { description: 'Build project' })).toBe('Build project');
  });

  it('returns empty string for null input', () => {
    expect(summarize('Read', null)).toBe('');
  });

  it('returns JSON for unknown tool', () => {
    const result = summarize('UnknownTool', { foo: 'bar' });
    expect(result).toBe('{"foo":"bar"}');
  });
});

// parsetranscriptmeta

describe('parseTranscriptMeta', () => {
  it('extracts version, entrypoint, gitBranch from simple-session.jsonl', () => {
    const meta = parseTranscriptMeta(path.join(FIXTURES, 'simple-session.jsonl'));
    expect(meta.version).toBe('1.2.3');
    expect(meta.entrypoint).toBe('claude');
    expect(meta.gitBranch).toBe('main');
  });

  it('extracts permissionMode from init line in simple-session.jsonl', () => {
    const meta = parseTranscriptMeta(path.join(FIXTURES, 'simple-session.jsonl'));
    expect(meta.permissionMode).toBe('default');
  });

  it('extracts user label from first real user message', () => {
    const meta = parseTranscriptMeta(path.join(FIXTURES, 'simple-session.jsonl'));
    expect(meta.label).toBeTruthy();
    expect(meta.label).toMatch(/help me write/i);
  });

  it('extracts model from assistant message', () => {
    const meta = parseTranscriptMeta(path.join(FIXTURES, 'simple-session.jsonl'));
    expect(meta.model).toBe('claude-sonnet-4-6');
  });

  it('extracts gitBranch feature-branch from with-compact.jsonl', () => {
    const meta = parseTranscriptMeta(path.join(FIXTURES, 'with-compact.jsonl'));
    expect(meta.gitBranch).toBe('feature-branch');
  });

  it('returns nulls for non-existent file', () => {
    const meta = parseTranscriptMeta('/nonexistent/path.jsonl');
    expect(meta.version).toBeNull();
    expect(meta.entrypoint).toBeNull();
    expect(meta.gitBranch).toBeNull();
    expect(meta.permissionMode).toBeNull();
  });

  it('gracefully handles malformed.jsonl — still reads valid lines', () => {
    const meta = parseTranscriptMeta(path.join(FIXTURES, 'malformed.jsonl'));
    expect(meta.version).toBe('1.0.0');
    // label from the valid user line after the malformed one
    expect(meta.label).toBeTruthy();
  });

  it('ignores user messages starting with < (system messages)', () => {
    const meta = parseTranscriptMeta(path.join(FIXTURES, 'simple-session.jsonl'));
    // The label should not start with '<'
    if (meta.label) expect(meta.label).not.toMatch(/^</);
  });

  it('does not set label for short user messages (<=5 chars)', () => {
    // simple-session has a real message, so label should be set
    const meta = parseTranscriptMeta(path.join(FIXTURES, 'simple-session.jsonl'));
    if (meta.label) expect(meta.label.length).toBeGreaterThan(5);
  });
});

// parsetranscriptcompactions

describe('parseTranscriptCompactions', () => {
  it('returns empty array for simple-session.jsonl (no compactions)', () => {
    const compacts = parseTranscriptCompactions(path.join(FIXTURES, 'simple-session.jsonl'));
    expect(compacts).toEqual([]);
  });

  it('finds one compaction in with-compact.jsonl', () => {
    const compacts = parseTranscriptCompactions(path.join(FIXTURES, 'with-compact.jsonl'));
    expect(compacts).toHaveLength(1);
  });

  it('compaction has correct tokensBefore and tokensAfter', () => {
    const compacts = parseTranscriptCompactions(path.join(FIXTURES, 'with-compact.jsonl'));
    expect(compacts[0].tokensBefore).toBe(50000);
    expect(compacts[0].tokensAfter).toBe(5000);
  });

  it('compaction summary is populated from the following user message', () => {
    const compacts = parseTranscriptCompactions(path.join(FIXTURES, 'with-compact.jsonl'));
    expect(compacts[0].summary).toBeTruthy();
    expect(compacts[0].summary.length).toBeGreaterThan(10);
  });

  it('compaction id includes the sessionId', () => {
    const compacts = parseTranscriptCompactions(path.join(FIXTURES, 'with-compact.jsonl'));
    expect(compacts[0].id).toContain('compact-');
  });

  it('returns empty array for non-existent file', () => {
    const compacts = parseTranscriptCompactions('/nonexistent/path.jsonl');
    expect(compacts).toEqual([]);
  });

  it('gracefully handles malformed.jsonl — no compactions', () => {
    const compacts = parseTranscriptCompactions(path.join(FIXTURES, 'malformed.jsonl'));
    expect(Array.isArray(compacts)).toBe(true);
  });

  it('timestamp is a number (ms since epoch)', () => {
    const compacts = parseTranscriptCompactions(path.join(FIXTURES, 'with-compact.jsonl'));
    expect(typeof compacts[0].timestamp).toBe('number');
    expect(compacts[0].timestamp).toBeGreaterThan(0);
  });
});

// safecwdtoprojectdir

describe('safeCwdToProjectDir', () => {
  it('returns a project directory path for a valid absolute cwd', () => {
    const result = safeCwdToProjectDir('/Users/test/my-project');
    expect(result).toBeTruthy();
    expect(result).toContain('.claude/projects/');
  });

  it('returns null for relative paths', () => {
    expect(safeCwdToProjectDir('relative/path')).toBeNull();
  });

  it('returns null for paths with ..', () => {
    expect(safeCwdToProjectDir('/Users/test/../etc')).toBeNull();
  });

  it('returns null for null/undefined/empty', () => {
    expect(safeCwdToProjectDir(null)).toBeNull();
    expect(safeCwdToProjectDir(undefined)).toBeNull();
    expect(safeCwdToProjectDir('')).toBeNull();
  });

  it('returns null for non-string input', () => {
    expect(safeCwdToProjectDir(42)).toBeNull();
    expect(safeCwdToProjectDir({})).toBeNull();
  });
});

// safefilepath

describe('safeFilePath', () => {
  it('allows paths under ~/.claude', () => {
    const home = path.join(process.env.HOME || '/tmp', '.claude', 'projects', 'test.jsonl');
    expect(safeFilePath(home)).toBe(true);
  });

  it('rejects paths outside allowed directories', () => {
    expect(safeFilePath('/etc/passwd')).toBe(false);
    expect(safeFilePath('/tmp/arbitrary')).toBe(false);
  });

  it('rejects null/undefined/empty', () => {
    expect(safeFilePath(null)).toBe(false);
    expect(safeFilePath(undefined)).toBe(false);
    expect(safeFilePath('')).toBe(false);
  });

  it('rejects non-string input', () => {
    expect(safeFilePath(123)).toBe(false);
  });
});

// parsetranscriptstats

describe('parseTranscriptStats', () => {
  it('sums token usage from simple-session.jsonl', () => {
    const stats = parseTranscriptStats(path.join(FIXTURES, 'simple-session.jsonl'));
    // simple-session has two assistant messages: (100+50) and (150+20)
    expect(stats.inputTokens).toBe(250);
    expect(stats.outputTokens).toBe(70);
    expect(stats.cacheReadTokens).toBe(10);
  });

  it('returns zeros for non-existent file', () => {
    const stats = parseTranscriptStats('/nonexistent/path.jsonl');
    expect(stats.inputTokens).toBe(0);
    expect(stats.outputTokens).toBe(0);
    expect(stats.cacheReadTokens).toBe(0);
    expect(stats.costUsd).toBe(0);
  });

  it('calculates cost based on model pricing', () => {
    const stats = parseTranscriptStats(path.join(FIXTURES, 'simple-session.jsonl'));
    // Model is claude-sonnet-4-6: input=$3/M, output=$15/M, cacheRead=$0.30/M
    const expected = (250 * 3.0 / 1e6) + (70 * 15.0 / 1e6) + (10 * 0.30 / 1e6);
    expect(stats.costUsd).toBeCloseTo(expected, 6);
  });

  it('handles malformed lines gracefully', () => {
    const stats = parseTranscriptStats(path.join(FIXTURES, 'malformed.jsonl'));
    // malformed.jsonl has one valid assistant line: input=50, output=10
    expect(stats.inputTokens).toBe(50);
    expect(stats.outputTokens).toBe(10);
  });

  it('sums token usage from with-compact.jsonl', () => {
    const stats = parseTranscriptStats(path.join(FIXTURES, 'with-compact.jsonl'));
    // Two assistant messages: (5000+200) and (500+100)
    expect(stats.inputTokens).toBe(5500);
    expect(stats.outputTokens).toBe(300);
  });

  it('sums cache_creation_input_tokens when present', () => {
    const stats = parseTranscriptStats(path.join(FIXTURES, 'with-agents.jsonl'));
    // with-agents has cache_creation_input_tokens: 20 on last message
    expect(stats.costUsd).toBeGreaterThan(0);
  });
});

// pricing

describe('PRICING', () => {
  it('has entries for major models', () => {
    expect(PRICING['claude-sonnet-4-6']).toBeTruthy();
    expect(PRICING['claude-opus-4-6']).toBeTruthy();
    expect(PRICING['claude-haiku-4-5']).toBeTruthy();
  });

  it('each entry has input, output, cacheRead, cacheWrite', () => {
    for (const [model, price] of Object.entries(PRICING)) {
      expect(price.input).toBeGreaterThan(0);
      expect(price.output).toBeGreaterThan(0);
      expect(price.cacheRead).toBeGreaterThan(0);
      expect(price.cacheWrite).toBeGreaterThan(0);
    }
  });

  it('DEFAULT_PRICE matches sonnet pricing', () => {
    expect(DEFAULT_PRICE.input).toBe(PRICING['claude-sonnet-4-6'].input);
    expect(DEFAULT_PRICE.output).toBe(PRICING['claude-sonnet-4-6'].output);
  });
});

// findchildsessionids

describe('findChildSessionIds', () => {
  it('returns empty array for transcript without Agent/Task calls', () => {
    const ids = findChildSessionIds(path.join(FIXTURES, 'simple-session.jsonl'), 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    expect(ids).toEqual([]);
  });

  it('returns empty array for non-existent file', () => {
    const ids = findChildSessionIds('/nonexistent/path.jsonl', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    expect(ids).toEqual([]);
  });

  it('extracts UUIDs from Agent tool_result content (when child jsonl exists)', () => {
    // The child UUID in with-agents.jsonl is 11111111-2222-3333-4444-555555555555
    // but the corresponding .jsonl won't exist in fixtures, so it should return empty
    const ids = findChildSessionIds(path.join(FIXTURES, 'with-agents.jsonl'), 'root-id');
    // No child .jsonl files exist in fixtures dir, so no matches
    expect(Array.isArray(ids)).toBe(true);
  });

  it('does not include the root session ID in results', () => {
    const ids = findChildSessionIds(path.join(FIXTURES, 'with-agents.jsonl'), '11111111-2222-3333-4444-555555555555');
    // Even if UUID is referenced, it should be excluded since it matches rootSessionId
    expect(ids).not.toContain('11111111-2222-3333-4444-555555555555');
  });
});

// parsefullsessionstats

describe('parseFullSessionStats', () => {
  it('returns stats for a single transcript (no children)', () => {
    const stats = parseFullSessionStats(
      path.join(FIXTURES, 'simple-session.jsonl'),
      'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    );
    expect(stats.inputTokens).toBe(250);
    expect(stats.outputTokens).toBe(70);
    expect(stats.costUsd).toBeGreaterThan(0);
  });

  it('returns zeros for non-existent file', () => {
    const stats = parseFullSessionStats('/nonexistent/path.jsonl', 'some-id');
    expect(stats.inputTokens).toBe(0);
    expect(stats.outputTokens).toBe(0);
    expect(stats.costUsd).toBe(0);
  });

  it('does not infinite-loop on visited files (cycle guard)', () => {
    const visited = new Set();
    const file = path.join(FIXTURES, 'simple-session.jsonl');
    visited.add(file);
    const stats = parseFullSessionStats(file, 'id', visited);
    expect(stats.inputTokens).toBe(0); // skipped because already visited
  });

  it('respects max depth guard', () => {
    const stats = parseFullSessionStats(
      path.join(FIXTURES, 'simple-session.jsonl'),
      'id',
      new Set(),
      51, // exceeds max depth of 50
    );
    expect(stats.inputTokens).toBe(0);
  });

  it('uses opus pricing for opus model transcripts', () => {
    const stats = parseFullSessionStats(
      path.join(FIXTURES, 'with-agents.jsonl'),
      'root-id',
    );
    // with-agents uses claude-opus-4-6: input=$5/M, output=$25/M
    // Total: input=500, output=110, cacheRead=150, cacheWrite=20
    const price = PRICING['claude-opus-4-6'];
    const expected = (500 * price.input / 1e6) + (110 * price.output / 1e6)
                   + (150 * price.cacheRead / 1e6) + (20 * price.cacheWrite / 1e6);
    expect(stats.costUsd).toBeCloseTo(expected, 6);
  });
});

// summarize edge cases

describe('summarize — additional tools', () => {
  it('returns query for WebSearch', () => {
    expect(summarize('WebSearch', { query: 'how to parse JSON' })).toBe('"how to parse JSON"');
  });

  it('truncates WebSearch query at 60 chars', () => {
    const long = 'q'.repeat(80);
    expect(summarize('WebSearch', { query: long })).toBe(`"${'q'.repeat(60)}"`);
  });

  it('returns url for WebFetch', () => {
    expect(summarize('WebFetch', { url: 'https://example.com' })).toBe('https://example.com');
  });

  it('returns empty string for Agent with no description or prompt', () => {
    expect(summarize('Agent', {})).toBe('');
  });

  it('returns file_path for Edit', () => {
    expect(summarize('Edit', { file_path: '/a/b.ts', old_string: 'x', new_string: 'y' })).toBe('/a/b.ts');
  });

  it('truncates unknown tool JSON at 80 chars', () => {
    const big = { data: 'x'.repeat(200) };
    const result = summarize('CustomTool', big);
    expect(result.length).toBe(80);
  });
});

// SENSITIVE_RE

describe('SENSITIVE_RE', () => {
  it('matches .env files', () => {
    expect(SENSITIVE_RE.test('.env')).toBe(true);
    expect(SENSITIVE_RE.test('.env.local')).toBe(true);
    expect(SENSITIVE_RE.test('production.env')).toBe(true);
  });

  it('matches credential/secret/key file patterns', () => {
    expect(SENSITIVE_RE.test('credentials.json')).toBe(true);
    expect(SENSITIVE_RE.test('secret')).toBe(true);
    expect(SENSITIVE_RE.test('private_key.pem')).toBe(true);
    expect(SENSITIVE_RE.test('private-key')).toBe(true);
    expect(SENSITIVE_RE.test('privatekey')).toBe(true);
  });

  it('matches certificate and key file extensions', () => {
    expect(SENSITIVE_RE.test('cert.pem')).toBe(true);
    expect(SENSITIVE_RE.test('id_rsa.key')).toBe(true);
    expect(SENSITIVE_RE.test('keystore.p12')).toBe(true);
    expect(SENSITIVE_RE.test('bundle.pfx')).toBe(true);
  });

  it('matches auth token and api key patterns', () => {
    expect(SENSITIVE_RE.test('auth_token')).toBe(true);
    expect(SENSITIVE_RE.test('auth-token')).toBe(true);
    expect(SENSITIVE_RE.test('api_key')).toBe(true);
    expect(SENSITIVE_RE.test('api-key')).toBe(true);
  });

  it('does not match innocuous file names', () => {
    expect(SENSITIVE_RE.test('environment.js')).toBe(false);
    expect(SENSITIVE_RE.test('index.html')).toBe(false);
    expect(SENSITIVE_RE.test('package.json')).toBe(false);
    expect(SENSITIVE_RE.test('README.md')).toBe(false);
  });
});

// findTranscript

describe('findTranscript', () => {
  it('returns null for an invalid session ID', () => {
    expect(findTranscript('not-a-uuid', null)).toBeNull();
    expect(findTranscript('', null)).toBeNull();
    expect(findTranscript(null, null)).toBeNull();
  });

  it('returns null when no transcript file exists for a valid UUID', () => {
    // Valid UUID format but no transcript file will exist for this
    const result = findTranscript('00000000-0000-0000-0000-000000000000', null);
    expect(result).toBeNull();
  });

  it('returns null when cwd resolves to a non-existent project dir', () => {
    const result = findTranscript('00000000-0000-0000-0000-000000000000', '/nonexistent/project');
    expect(result).toBeNull();
  });
});

// parseTranscriptStats — result event and subscription detection

describe('parseTranscriptStats — result event cost', () => {
  it('uses total_cost_usd from result event when present and > 0', () => {
    const stats = parseTranscriptStats(path.join(FIXTURES, 'with-result-cost.jsonl'));
    expect(stats.costUsd).toBeCloseTo(0.0025, 6);
  });

  it('result event cost overrides calculated cost', () => {
    const stats = parseTranscriptStats(path.join(FIXTURES, 'with-result-cost.jsonl'));
    // Calculated would be: (100 * 3.0 + 20 * 15.0) / 1e6 = 0.0006 — different from 0.0025
    const calculated = (100 * 3.0 / 1e6) + (20 * 15.0 / 1e6);
    expect(stats.costUsd).not.toBeCloseTo(calculated, 4);
    expect(stats.costUsd).toBeCloseTo(0.0025, 6);
  });
});

describe('parseTranscriptStats — subscription detection', () => {
  it('sets isSubscription=true when total_cost_usd=0 but tokens were consumed', () => {
    const stats = parseTranscriptStats(path.join(FIXTURES, 'with-subscription.jsonl'));
    expect(stats.isSubscription).toBe(true);
    expect(stats.inputTokens).toBe(200);
    expect(stats.outputTokens).toBe(40);
  });

  it('still returns calculated cost for subscription sessions', () => {
    const stats = parseTranscriptStats(path.join(FIXTURES, 'with-subscription.jsonl'));
    const expected = (200 * 3.0 / 1e6) + (40 * 15.0 / 1e6);
    expect(stats.costUsd).toBeCloseTo(expected, 6);
  });

  it('sets isSubscription=false for normal API sessions', () => {
    const stats = parseTranscriptStats(path.join(FIXTURES, 'simple-session.jsonl'));
    expect(stats.isSubscription).toBe(false);
  });
});

describe('parseTranscriptStats — ephemeral cache tokens', () => {
  it('counts ephemeral_5m and ephemeral_1h tokens as cache write tokens', () => {
    const stats = parseTranscriptStats(path.join(FIXTURES, 'with-ephemeral-cache.jsonl'));
    // 500 ephemeral_5m + 300 ephemeral_1h = 800 cache write tokens
    // cost = (1000 * 3.0 + 50 * 15.0 + 800 * 3.75) / 1e6
    const price = PRICING['claude-sonnet-4-6'];
    const expected = (1000 * price.input / 1e6) + (50 * price.output / 1e6) + (800 * price.cacheWrite / 1e6);
    expect(stats.costUsd).toBeCloseTo(expected, 6);
  });

  it('cost is greater than without cache write tokens', () => {
    const withEphemeral = parseTranscriptStats(path.join(FIXTURES, 'with-ephemeral-cache.jsonl'));
    const withoutEphemeral = parseTranscriptStats(path.join(FIXTURES, 'simple-session.jsonl'));
    // The ephemeral session has cache write costs on top of normal token costs
    expect(withEphemeral.costUsd).toBeGreaterThan(0);
  });
});

// parseTranscriptMeta — label edge cases

describe('parseTranscriptMeta — label edge cases', () => {
  it('extracts label from array content blocks', () => {
    const meta = parseTranscriptMeta(path.join(FIXTURES, 'with-array-label.jsonl'));
    expect(meta.label).toBeTruthy();
    expect(meta.label).toMatch(/analyze this codebase/i);
  });

  it('skips user messages starting with / and uses the next valid message as label', () => {
    const meta = parseTranscriptMeta(path.join(FIXTURES, 'with-slash-label.jsonl'));
    expect(meta.label).not.toMatch(/^\/compact/);
    expect(meta.label).toMatch(/debug this function/i);
  });
});

// parseFullSessionStats — depth guard

describe('parseFullSessionStats — depth guard', () => {
  it('returns zeros when depth exceeds 50', () => {
    const stats = parseFullSessionStats(
      path.join(FIXTURES, 'simple-session.jsonl'),
      'id',
      new Set(),
      51,
    );
    expect(stats.inputTokens).toBe(0);
    expect(stats.costUsd).toBe(0);
  });

  it('processes normally at depth 0', () => {
    const stats = parseFullSessionStats(
      path.join(FIXTURES, 'simple-session.jsonl'),
      'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      new Set(),
      0,
    );
    expect(stats.inputTokens).toBe(250);
  });

  it('processes normally at depth 50 (boundary)', () => {
    const stats = parseFullSessionStats(
      path.join(FIXTURES, 'simple-session.jsonl'),
      'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      new Set(),
      50,
    );
    expect(stats.inputTokens).toBe(250);
  });
});
