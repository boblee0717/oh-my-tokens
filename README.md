# oh-my-tokens

A local-first usage dashboard for your AI coding tools — **Codex**, **Claude Code**, **DeepSeek**, and **Cursor**. See it in a **Chrome popup** or a **macOS menu-bar app**: token counts, estimated cost (totalled across all providers), plan-usage %, and balances at a glance.

Built for personal and team use: install it, adapt it, and make your own version.

## Install — pick your setup

Everything starts from one clone; then you choose *how you want to see* your usage. On
**macOS you can run the menu-bar app on its own, the Chrome extension on its own, or both.**

| Setup | One command | What you get | Needs Chrome running? |
|-------|-------------|--------------|:---------------------:|
| 🎫 **macOS menu bar** (standalone) | `./install.sh --menubar` | Every tool's tokens / cost / requests **+ Cursor plan-usage % & cost**, in the menu bar | **No** — updates with Chrome closed |
| 🧩 **Chrome extension** (popup) | `./install.sh` + load unpacked | The same, in a popup — **plus** login-gated plan-usage % for **Claude.ai** & **Codex** | Yes |
| **Both** | `--menubar` + load the extension | Menu bar **and** popup; the menu bar then also shows Claude/Codex plan-usage % | Yes |

> **Why two paths?** Token/cost come from local logs, and Cursor's usage is reachable with
> your saved cookie — so the menu bar runs standalone. Claude.ai / Codex plan-usage % sit
> behind Cloudflare and can only be fetched from inside the browser, so those need the extension.

**What shows where:**

| Data | 🎫 Menu bar | 🧩 Extension |
|------|:----------:|:-----------:|
| Local tokens / cost / requests (Claude Code · Codex · DeepSeek) | ✅ | ✅ |
| Cursor tokens / cost / plan-usage % | ✅ | ✅ |
| Claude.ai / Codex plan-usage % | ↳ from the extension¹ | ✅ |
| Show / hide providers | — | ✅ |

¹ the menu bar shows Claude/Codex plan-usage % only after the extension has fetched it (Cloudflare blocks a standalone fetch); everything else the menu bar gets on its own.

**First, clone** (or hand this repo to your coding agent and say **"install this"** — ~1 min):

```bash
git clone https://github.com/boblee0717/oh-my-tokens.git /tmp/oh-my-tokens
cd /tmp/oh-my-tokens
```

### Option A — macOS menu bar (standalone, no browser)

```bash
./install.sh --menubar      # host + SwiftBar (free, notarized) + the 🎫 plugin
```

A 🎫 item appears showing **today's total estimated cost**; the dropdown breaks down
plan-usage % and per-provider tokens/cost in one tap. Cursor + local data refresh on their
own (Cursor via your saved `cursor.com` cookie), so it stays current with Chrome closed.
Details + uninstall: [`menubar/README.md`](./menubar/README.md).

### Option B — Chrome extension (popup)

**macOS / Linux:**

```bash
./install.sh                # registers the native host (fixed Extension ID)
#   --deepseek-key sk-...    also set the DeepSeek key (→ ~/.oh-my-tokens/config.json)
#   --browser canary|beta|edge
#   --launch                 quit Chrome first, then auto-load the extension (no manual step)
```

**Windows (PowerShell):**

```powershell
git clone https://github.com/boblee0717/oh-my-tokens.git $env:TEMP\oh-my-tokens
powershell -ExecutionPolicy Bypass -File $env:TEMP\oh-my-tokens\install.ps1
#   -DeepSeekKey sk-...   also set the DeepSeek key (→ ~/.oh-my-tokens/config.json)
#   -Browser edge|chromium|beta|canary
```

The installer copies the host runtime to `~/.oh-my-tokens/native-host/` and registers the
browser against that stable path (on Windows via the per-user registry, `run-host.cmd`, no
admin). Then load the extension once: **chrome://extensions → Developer mode → Load unpacked
→ `extension/`** (or quit Chrome and use `--launch`). Extension ID is fixed:
`obmkhlamcmbmacadoolbfaagmojdobah`.

> **Why a host?** A sandboxed extension can't read local files, so it reads your `~/.claude` /
> `~/.codex` logs through a Native Messaging host. `install.sh` automates everything
> scriptable; only loading an unpacked extension into an *already-running* Chrome needs a click.

### Both

Run `./install.sh --menubar` **and** load the extension (Option B). With the extension
running, the menu bar also picks up Claude.ai / Codex plan-usage %.

### Prerequisites

- macOS or Windows, **Node ≥ 18**. The extension needs Chrome / Edge / Chromium; the
  menu-bar path installs **SwiftBar** for you (macOS only).
- Claude Code and/or Codex used on this machine (logs in `~/.claude/` / `~/.codex/`, i.e.
  `%USERPROFILE%\.claude` / `%USERPROFILE%\.codex` on Windows).

### DeepSeek API key (optional)

For DeepSeek balance: `install.sh --deepseek-key sk-...`, the extension Options page, or
`~/.oh-my-tokens/config.json`:

```json
{ "deepseekApiKey": "sk-..." }
```

### Verify

- **Menu bar:** the 🎫 dropdown shows live numbers. Check the host directly with
  `node ~/.oh-my-tokens/native-host/host/index.js`.
- **Extension:** open the popup — if only the bundled **sample** data shows, the host isn't
  connected; reload the extension and re-check.

### Show only the tools you use

Don't use one of the providers? Hide it from the **pills at the top of the popup** or the
**Options page** — a hidden provider is neither displayed nor queried.

---

## Why

These tools track usage separately (or not in a glanceable way). `oh-my-tokens` aggregates token counts, estimated cost, and remaining balance into **one place — a Chrome popup or a macOS menu bar**.

## Architecture

One **Native Messaging host** (log parsers + a DeepSeek client + a standalone Cursor fetch) feeds two independent viewers. No long-running daemon and no open port: the host runs on demand, reads logs / calls APIs, returns JSON, and exits.

```
  Chrome extension (popup) ─┐                         ┌─▶ ~/.claude, ~/.codex   (local logs)
                            ├─▶  Native host  ───────▶├─▶ api.deepseek.com      (balance, your key)
  macOS menu bar (SwiftBar)─┘    (on-demand)          └─▶ cursor.com            (your saved cookie)
```

Both viewers read the same host. The **menu bar** runs the host CLI on a ~1-minute timer and
needs **no extension**; the **extension** adds the one thing a standalone process can't get —
Claude.ai / Codex plan-usage % (browser-only, behind Cloudflare).

## Data sources

| Tool | Source | What we get |
|------|--------|-------------|
| **Claude Code** | local JSONL `~/.claude/projects/**/*.jsonl` | per-message tokens + estimated cost by model |
| **Codex** | local `~/.codex/sessions/` + `archived_sessions/` | session tokens + estimated cost (assumed GPT pricing) + quota % (5h + weekly) + plan + reset |
| **DeepSeek** | DeepSeek API (balance) + platform.deepseek.com (token usage) | balance + per-model per-day token usage |
| **Cursor** | cursor.com dashboard API (popup; **and the menu-bar host standalone, via your saved cookie**) + local sqlite fallback | per-model tokens + estimated cost, quota %; prompts login when signed out |

Codex, Claude Code, and Cursor **quota %** render as progress bars; DeepSeek shows balance. Cost figures are **estimates, not billing** — Claude uses a published price table, Codex an **assumed** GPT-tier table (edit `host/pricing.js`), Cursor its own per-event reported value. In the **menu bar**, Claude.ai / Codex quota % arrive via the extension (Cloudflare blocks a standalone fetch); everything else the menu bar gets on its own.

## Repo layout

```
oh-my-tokens/
├─ extension/   # MV3 Chrome extension (no build step, no deps)
├─ host/        # Native Messaging host (log parsers + DeepSeek client + standalone Cursor fetch)
│  └─ parsers/  # claude / codex / deepseek / cursor
├─ menubar/     # macOS menu-bar app (SwiftBar plugin + installer)
├─ shared/      # UsageRecord schema
└─ README.md
```

## Privacy

Log parsing happens entirely on your machine. The host returns only **aggregated** usage (no raw prompts/responses). The only outbound calls are to DeepSeek's API (with your key) and to claude.ai / platform.deepseek.com / cursor.com for quota and token usage.

**Menu-bar standalone fetch (macOS):** to show Cursor usage without Chrome open, the host reads your saved `cursor.com` cookie from the local Chrome cookie store — decrypted with the key in your login Keychain (you approve this once via the standard macOS prompt). The cookie is used only to call `cursor.com` from your own machine; it is never logged, stored elsewhere, or sent anywhere but cursor.com.

## License

MIT. In plain English: anyone can use, copy, modify, and redistribute this project, including for their own customized version.

See [LICENSE](./LICENSE) for the full text.

## Status

Ready to use on **macOS and Windows** (Chrome, Edge, or Chromium); the optional **menu-bar app is macOS-only**. On Windows the Cursor *local* fallback parser needs a `sqlite3` CLI on `PATH` (not bundled with Windows); without it Cursor data still comes from the web connector, which is the primary source. Linux follows the macOS path (`install.sh`).
