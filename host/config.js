import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

function configPaths() {
  const home = homedir();
  return [
    join(home, ".oh-my-tokens", "config.json"),
    join(home, ".config", "oh-my-tokens", "config.json"),
    join(HERE, "config.json"),
  ];
}

export async function getDeepSeekApiKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  for (const p of configPaths()) {
    try {
      const cfg = JSON.parse(await readFile(p, "utf8"));
      if (cfg && typeof cfg.deepseekApiKey === "string" && cfg.deepseekApiKey.trim()) {
        return cfg.deepseekApiKey.trim();
      }
    } catch {
    }
  }
  return undefined;
}
