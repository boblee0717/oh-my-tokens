# oh-my-tokens

A Chrome extension that shows your usage across multiple AI coding agents — **Codex**, **Claude Code**, and **DeepSeek** — in one place.

## Quickstart (for AI agents)

These steps are designed for an AI coding agent to execute. Run them verbatim.

### Prerequisites

- macOS, Chrome, Node ≥ 22
- Claude Code and/or Codex used on this machine (logs exist in `~/.claude/` / `~/.codex/`)

### 1. Clone

```bash
git clone https://github.com/boblee0717/oh-my-tokens.git /tmp/oh-my-tokens
```

### 2. Register the native messaging host

```bash
# Open chrome://extensions in the user's browser, enable "Developer mode",
# click "Load unpacked" and select /tmp/oh-my-tokens/extension.
# Copy the Extension ID shown on the card.
# Then register the host:
/tmp/oh-my-tokens/host/install-macos.sh <EXTENSION_ID>
```

If the user has Chrome Canary, Beta, or Edge, pass the channel name as the second argument (`canary`, `beta`, `edge`).

### 3. Verify

Open the extension popup. You should see usage data from the native host.

If only the bundled sample data appears, the Native Messaging host isn't connected. Check:
- Extension ID matches what `install-macos.sh` was called with
- The extension was reloaded after installation
- Run `node /tmp/oh-my-tokens/host/index.ts` directly to see the host report

### 4. Optional: DeepSeek API key

For DeepSeek balance, open the extension Options page and paste your key. Or create `~/.oh-my-tokens/config.json`:

```json
{ "deepseekApiKey": "sk-..." }
```

---

## Why

These tools track usage separately (or not in a glanceable way). `oh-my-tokens` aggregates token counts, estimated cost, and remaining balance into a single popup.

## Architecture

A **Chrome Native Messaging host** + the extension as a viewer. No long-running daemon, no open port: Chrome launches the host on demand, it reads logs (and calls the DeepSeek API), returns JSON, and exits.

```
┌─────────────┐   chrome.runtime.connectNative   ┌──────────────────┐
│  Extension  │ ───────────────────────────────▶ │  Native host     │
│ (MV3 popup) │ ◀────────── usage JSON ────────── │ (on-demand bin)  │
└─────────────┘                                   └────────┬─────────┘
        reads  ~/.claude/projects/**/*.jsonl  ◀─────────────┤
               ~/.codex/sessions/**           ◀─────────────┤
               api.deepseek.com/user/balance  ◀─────────────┘
```

## Data sources

| Tool | Source | What we get |
|------|--------|-------------|
| **Claude Code** | local JSONL `~/.claude/projects/**/*.jsonl` | per-message tokens + estimated cost by model |
| **Codex** | local `~/.codex/sessions/` + `archived_sessions/` | session tokens + quota % (5h + weekly) + plan + reset |
| **DeepSeek** | DeepSeek API (balance) + platform.deepseek.com (token usage) | balance + per-model per-day token usage |

Both Codex and Claude Code **quota %** render as progress bars. DeepSeek shows balance.

## Repo layout

```
oh-my-tokens/
├─ extension/   # MV3 Chrome extension (no build step, no deps)
├─ host/        # Native Messaging host (log parsers + DeepSeek client)
│  └─ parsers/  # claude / codex / deepseek
├─ shared/      # UsageRecord schema
└─ README.md
```

## Privacy

Log parsing happens entirely on your machine. The host returns only **aggregated** usage (no raw prompts/responses). The only outbound calls are to DeepSeek's API (with your key) and to claude.ai / platform.deepseek.com (via your logged-in browser session) for quota and token usage.

## Status

All MVP milestones are complete (M1–M11). Master is ready to use on macOS. Linux/Windows support is deferred.
