// Host-local configuration. Secrets (the DeepSeek API key) live here, never in the
// extension / browser storage. Resolution order:
//   1. env DEEPSEEK_API_KEY (handy for CLI / `node host/index.ts`)
//   2. ~/.oh-my-tokens/config.json        { "deepseekApiKey": "sk-..." }
//   3. ~/.config/oh-my-tokens/config.json (XDG-style alternative)
//   4. host/config.json (next to the host; gitignored)
// GUI Chrome on macOS does not inherit shell env, so the config file is the practical path.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

function configPaths(): string[] {
  const home = homedir();
  return [
    join(home, ".oh-my-tokens", "config.json"),
    join(home, ".config", "oh-my-tokens", "config.json"),
    join(HERE, "config.json"),
  ];
}

export async function getDeepSeekApiKey(): Promise<string | undefined> {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  for (const p of configPaths()) {
    try {
      const cfg = JSON.parse(await readFile(p, "utf8"));
      if (cfg && typeof cfg.deepseekApiKey === "string" && cfg.deepseekApiKey.trim()) {
        return cfg.deepseekApiKey.trim();
      }
    } catch {
      // missing / unreadable / malformed → try the next candidate
    }
  }
  return undefined;
}
