# oh-my-tokens

A Chrome extension that shows your usage across multiple AI coding agents — **Codex**, **Claude Code**, and **DeepSeek** — in one place.

> 🚧 **Status: early scaffolding / WIP.** The architecture below is the agreed plan, not a finished implementation.

## Why

These tools track usage separately (or not in a glanceable way). `oh-my-tokens` aggregates token counts, estimated cost, and remaining balance into a single popup.

## The core constraint

Claude Code and Codex are typically used via **subscription** (Claude Max, ChatGPT). **Subscription usage has no official API** — Anthropic's and OpenAI's usage/cost APIs only report *API-key / organization* usage. So Claude Code and Codex usage exists **only in local log files** on your machine. A Chrome extension is sandboxed and cannot read local files, so a small local helper is required for those two. DeepSeek is pay-as-you-go (API key), so its balance comes straight from its API.

## Architecture

A **Chrome [Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging) host** + the extension as a viewer. No long-running daemon and no open network port: Chrome launches the host on demand, it reads the logs (and calls the DeepSeek API), returns JSON, and exits.

```
┌─────────────┐   chrome.runtime.connectNative   ┌──────────────────┐
│  Extension  │ ───────────────────────────────▶ │  Native host     │
│ (MV3 popup) │ ◀────────── usage JSON ────────── │ (on-demand bin)  │
└─────────────┘                                   └────────┬─────────┘
        reads  ~/.claude/projects/**/*.jsonl  ◀─────────────┤
               ~/.codex/sessions/**           ◀─────────────┤
               api.deepseek.com/user/balance  ◀─────────────┘
```

- The DeepSeek API key lives **only in the native host's local config**, never in the extension's storage.
- A `localhost` HTTP transport is kept only as an optional **dev/debug fallback**, not the default.

## Data sources

| Tool | Source | What we get |
|------|--------|-------------|
| **Claude Code** | local JSONL `~/.claude/projects/**/*.jsonl` | per-message `usage` (input / output / cache tokens) → tokens + **estimated** cost by model |
| **Codex** | local `~/.codex/sessions/` + `archived_sessions/` | session logs with token usage |
| **DeepSeek** | DeepSeek API (`GET /user/balance`) | account balance; requires an API key |

> **Subscription quota is not available.** For Claude Code and Codex we show local-log tokens + an **estimated** cost only — never an official "plan remaining". Only DeepSeek reports a real balance.

## Repo layout

```
oh-my-tokens/
├─ extension/   # MV3 Chrome extension: popup UI, background service worker, options page
├─ host/        # Native Messaging host: log parsers + DeepSeek client + manifest install
│  └─ parsers/  # claude / codex / deepseek
├─ shared/      # normalized usage schema + shared types
├─ README.md
└─ .gitignore
```

See [`shared/schema.ts`](shared/schema.ts) for the normalized usage record.

## Platform

**macOS first** (paths `~/.claude`, `~/.codex`; native-host manifest install for Chrome on macOS). Linux/Windows are deferred until after the MVP.

## Configuration & secrets

The DeepSeek API key and any credentials go in the native host's local config and are **never** committed. See `.gitignore`.

## Privacy

Log parsing happens entirely on your machine; Claude Code / Codex usage never leaves it. The host returns only **aggregated** usage (no raw prompts/responses). The only outbound call is the DeepSeek balance lookup, to DeepSeek's API with your key.

## Roadmap

- [x] **M1** — native host parses Claude Code logs → usage JSON (reconciled against `ccusage`, ~99.9% on tokens)
- [x] **M2** — Codex session parser (+ dedup across `sessions/` and `archived_sessions/`)
- [x] **M3** — DeepSeek client (balance)
- [ ] **M4** — extension popup UI (per-provider cards, time-window toggle, refresh) + options
- [ ] **M5** — packaging + native-host manifest install docs
