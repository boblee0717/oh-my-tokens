# oh-my-tokens

A Chrome extension that shows your usage across multiple AI coding agents — **Codex**, **Claude Code**, and **DeepSeek** — in one place.

## Install this (with a coding agent)

Send this repo to your coding agent (Claude Code, Codex, …) and say **"install this"**.
It takes ~1 minute.

```bash
git clone https://github.com/boblee0717/oh-my-tokens.git /tmp/oh-my-tokens
/tmp/oh-my-tokens/install.sh        # registers the native host (fixed Extension ID)
#   --deepseek-key sk-...   also set the DeepSeek key (→ ~/.oh-my-tokens/config.json)
#   --browser canary|beta|edge
```

**Fully automatic (Chrome not running):** quit Chrome, then `./install.sh --launch` — it
registers the host *and* auto-loads the extension (verified). No manual step.

**Chrome already open:** macOS ignores the load flag, so load the extension once:
**chrome://extensions → Developer mode → Load unpacked → `/tmp/oh-my-tokens/extension`**
(or quit Chrome and use `--launch`). Then click the toolbar icon.

The Extension ID is fixed: `obmkhlamcmbmacadoolbfaagmojdobah`.

> Why the host (and why it isn't pure-zero-click): this extension reads your local
> `~/.claude` / `~/.codex` logs via a Native Messaging host (a sandboxed extension can't read
> local files). `install.sh` automates everything scriptable; only loading an unpacked
> extension into an *already-running* Chrome needs a click — Chrome's own limitation.

### Prerequisites

- macOS, Chrome, Node ≥ 18
- Claude Code and/or Codex used on this machine (logs in `~/.claude/` / `~/.codex/`)

### Verify

Open the popup — you should see live usage. If only the bundled **sample** data shows, the
host isn't connected: confirm the extension was reloaded, and run
`node /tmp/oh-my-tokens/host/index.js` to check the host report directly.

### DeepSeek API key (optional)

For DeepSeek balance, either `install.sh --deepseek-key sk-...`, paste it in the extension
Options page, or create `~/.oh-my-tokens/config.json`:

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
