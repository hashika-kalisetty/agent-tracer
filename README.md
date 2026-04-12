# agent-tracer

A browser-based trace viewer designed to provide deep visibility into Claude Code agents and commands. 
agent-tracer offers a live, interactive view of agent hierarchies, subagents, tool calls, token usage, and cost as Claude Code operates. 
Sessions are automatically persisted across restarts, enabling seamless inspection and analysis of agent activity over time.

## Requirements

- Node.js 18+
- Claude Code CLI

## Installing prerequisites

### Node.js

**macOS / Linux / Unix**
```bash
# macOS — Homebrew
brew install node

# Ubuntu / Debian
sudo apt install -y nodejs npm

# Fedora / RHEL
sudo dnf install nodejs

# Any platform — nvm (recommended for version control)
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
nvm install --lts

# Or download a binary from https://nodejs.org
```

**Windows**
```powershell
# winget
winget install OpenJS.NodeJS.LTS

# Or download the installer from https://nodejs.org
```

Verify: `node --version` should print `v18` or higher.

### Claude Code

**macOS / Linux / WSL** (auto-updates)
```bash
curl -fsSL https://claude.ai/install.sh | bash
```

**macOS — Homebrew**
```bash
brew install --cask claude-code
```
> Does not auto-update. Run `brew upgrade claude-code` periodically.

**Windows — PowerShell** (auto-updates)
```powershell
irm https://claude.ai/install.ps1 | iex
```

**Windows — CMD**
```batch
curl -fsSL https://claude.ai/install.cmd -o install.cmd && install.cmd && del install.cmd
```
> Windows requires [Git for Windows](https://git-scm.com/downloads/win) installed first.

**Windows — WinGet**
```powershell
winget install Anthropic.ClaudeCode
```
> Does not auto-update. Run `winget upgrade Anthropic.ClaudeCode` periodically.

After installation, run `claude` once to complete sign-in before starting the daemon.

## Setup

**Option 1: From source**

```bash
git clone https://github.com/hashikakalisetty/agent-tracer
cd agent-tracer
npm install
node bin/agent-tracer-daemon.js --install
node bin/agent-tracer-daemon.js
```

**Option 2: Global install**

```bash
npm i -g agent-tracer
agent-tracer-daemon --install
agent-tracer-daemon
```

Then launch Claude:

```bash
claude
```

`--install` makes one change to one file — `~/.claude/settings.json` — appending hooks so Claude Code sends events to the daemon:

| Hook | Trigger |
|------|---------|
| `PreToolUse` | Before every tool call |
| `PostToolUse` | After every tool call |
| `Stop` | When a session ends |
| `PreCompact` | Before context compaction |
| `PostCompact` | After context compaction |
| `SessionStart` | When a session starts |
| `UserPromptSubmit` | When you submit a prompt |
| `SubagentStop` | When a subagent finishes |
| `PostToolUseFailure` | When a tool call fails |
| `SessionEnd` | When a session ends |

Each hook POSTs the event to `http://localhost:4243/hook`. No data leaves your machine. Existing hooks are never overwritten — the installer only appends if the hook isn't already present.

Open the UI at `http://localhost:4243`.

From that point on, every Claude Code session is automatically traced. No changes to how you run Claude Code.

**Restarting the daemon**:

```bash
# Kill the running daemon
pkill -f agent-tracer-daemon

# Restart
node bin/agent-tracer-daemon.js

# Or as a one-liner:
pkill -f agent-tracer-daemon; node bin/agent-tracer-daemon.js
```

Then hard-refresh the browser (Cmd+Shift+R / Ctrl+Shift+R) to load the updated UI. Session history is persisted in SQLite and survives restarts.

## How it works

Claude Code fires lifecycle hooks (`PreToolUse`, `PostToolUse`, `Stop`, `SessionStart`, `SubagentStop`, and others) before and after each tool call and session event. The daemon receives these as HTTP POST requests on `localhost:4243`, stores them in SQLite, and pushes live updates to the browser over SSE (Server-Sent Events).

Session history survives daemon restarts. On startup, the daemon loads the last 100 sessions from the database and backfills any missing cost or token data from the transcript files Claude Code writes to `~/.claude/projects/`. A second backfill runs 2 seconds after startup to catch tokens that arrive after the initial load, and cost data is refreshed every 45 seconds while the daemon is running.

## UI

**Trace tab** — live view of running and recent sessions, grouped by project. The left panel shows a searchable tree of agents and their tool calls in order; click any row to see its full input, output, and duration in the detail panel. The graph button opens a hierarchical view of the agent and subagent tree for the selected session.

**History tab** — past sessions listed with timestamps and cost. Click any session to inspect its tool calls and read the full conversation thread, with user and assistant turns rendered side by side.

**Permissions tab** — a security and configuration overview drawn from `~/.claude/settings.json` and the live audit log. Shows the active permission mode, allowed/denied/asked tool rules, configured hooks, MCP servers, environment variables, additional file-access directories, tool usage stats, bash command history (with destructive commands highlighted), sensitive file accesses, and outbound network requests. Can be scoped to a single session or viewed globally across all sessions.

## File structure

```
bin/
  agent-tracer-daemon.js  entry point, HTTP server, all route handlers
lib/
  parser.js               transcript parsing, pricing, security helpers (no DB dependency)
  db.js                   SQLite schema, migrations, prepared statements
  session-store.js        in-memory session state, hook handler, SSE broadcast
public/
  index.html              browser UI (vanilla JS, no build step)
test/
  parser.test.js          unit tests for parser functions
  hook-integration.test.js  integration tests against a real daemon instance
```

## Configuration

**Port** — set the `PORT` environment variable (default: `4243`)
**Database path** — set `AGENT_TRACER_DB` to use a custom SQLite file (useful for testing)

```bash
PORT=4244 node bin/agent-tracer-daemon.js
AGENT_TRACER_DB=/tmp/test.db node bin/agent-tracer-daemon.js
```

## Running tests

```bash
npm test
```

The test suite spawns a daemon on port 14243 with a temp database, runs all hook scenarios over HTTP, then cleans up. Unit tests cover transcript parsing independently.

## Cost tracking

Token costs are calculated from the transcript files in `~/.claude/projects/`. Pricing is defined in `lib/parser.js` and covers all current Claude models. Costs are stored per session and updated after each `Stop` event and during periodic background refreshes.

**Subscription plans (Claude Max / Pro):** Claude Code does not report a cost figure in transcripts for subscription users. When tokens are present but no cost is reported, agent-trace detects this as a subscription session and displays an API-equivalent estimate — what the same token usage would cost on the pay-as-you-go API — labelled `sub`. This is not what you are charged; your subscription covers usage at a flat rate.

The header totals sum root sessions only — each root already includes its subagents recursively, so summing all nodes would double-count.
