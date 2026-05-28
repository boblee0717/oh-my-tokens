# oh-my-tokens

A local-first Chrome extension that shows your usage across AI coding tools — **Codex**, **Claude Code**, **DeepSeek**, and **Cursor** — in one popup.

Built for personal and team use: install it, adapt it, and make your own version.

## Install this (with a coding agent)

Send this repo to your coding agent (Claude Code, Codex, …) and say **"install this"**.
It takes ~1 minute.

```bash
git clone https://github.com/boblee0717/oh-my-tokens.git /tmp/oh-my-tokens
/tmp/oh-my-tokens/install.sh        # registers the native host (fixed Extension ID)
#   --deepseek-key sk-...   also set the DeepSeek key (→ ~/.oh-my-tokens/config.json)
#   --browser canary|beta|edge
```

The installer copies the Native Messaging host runtime to `~/.oh-my-tokens/native-host/`
and registers Chrome against that stable path, so the host is not executed from the
temporary clone directory.

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

### Show only the tools you use

Don't use one of the providers? Hide it from the **pills at the top of the popup** or the
**Options page** — a hidden provider is neither displayed nor queried.

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
| **Cursor** | cursor.com dashboard API + local sqlite fallback | per-model tokens + estimated cost, quota %; prompts login when signed out |

Codex, Claude Code, and Cursor **quota %** render as progress bars. DeepSeek shows balance.

## Repo layout

```
oh-my-tokens/
├─ extension/   # MV3 Chrome extension (no build step, no deps)
├─ host/        # Native Messaging host (log parsers + DeepSeek client)
│  └─ parsers/  # claude / codex / deepseek / cursor
├─ shared/      # UsageRecord schema
└─ README.md
```

## Privacy

Log parsing happens entirely on your machine. The host returns only **aggregated** usage (no raw prompts/responses). The only outbound calls are to DeepSeek's API (with your key) and to claude.ai / platform.deepseek.com / cursor.com (via your logged-in browser session) for quota and token usage.

## License

MIT. In plain English: anyone can use, copy, modify, and redistribute this project, including for their own customized version.

See [LICENSE](./LICENSE) for the full text.

## Status

All MVP milestones are complete (M1–M11). Master is ready to use on macOS. Linux/Windows support is deferred.
