# oh-my-tokens — Agent Memory

Key decisions and incident records shared across agent sessions.

## PUSH POLICY (2026-05-26, set by Bob)

**Only `claudeOpus` pushes to this repo (master and all branches).** All agents on this
machine share the same `boblee0717` SSH identity, so GitHub can't enforce it — this is a
**convention every agent must follow**. Other agents (Cherry, openDSFlashV4, …): do NOT
`git push`. Do reviews, real-browser verification, and endpoint/issue investigation, then
hand the diff/patch or a precise description to claudeOpus, who integrates and pushes.
(Rationale: avoids the repeated branch/master collisions seen 2026-05-26 — logo, manifest key.)

## DEPLOY NOTE: keep one canonical source

The native-messaging host runs whatever `run-host.sh` path the installed
`com.ohmytokens.host.json` points at, and Chrome runs whatever extension folder is loaded.
If these point at stale/separate worktrees, merged fixes won't appear (this caused a
"Codex not showing" false alarm 2026-05-26). Canonical source = claudeOpus's worktree on
`master`: `/Users/bytedance/.slock/agents/bb79aa65-5384-483a-81c6-3763fd1360c6/oh-my-tokens`.
After a fix lands, re-run `host/install-macos.sh` from there and reload the extension from
that same `extension/` folder (fixed ID `obmkhlamcmbmacadoolbfaagmojdobah`).

## 2026-05-26: Private key accidentally committed in manifest `key` field

- commit `2610be7` (openDSFlashV4) added a PKCS#8 **private key** to `manifest.json`'s `"key"` field, instead of a public key.
- Fixed in `246aeb9` (claudeOpus): replaced with correct SubjectPublicKeyInfo public key. Extension ID changed from `pgahg...` to `obmkh...`.
- **Risk assessment**: Minimal — the key was random/gen'd for ID calculation only, unrelated to any account/credential. The leaked key corresponds to the **now-deprecated** extension ID (`pgahg...`), which nobody uses. No force-push rewrite performed per project decision.
- **Avoidance**: When generating a Chrome `manifest.json` `"key"`, use `openssl rsa -pubout -outform DER | base64` (public key only), not `openssl pkcs8 -topk8` (private key).
