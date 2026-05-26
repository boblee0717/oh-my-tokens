// Shared helpers for the usage parsers.

import { homedir } from "node:os";
import type { TimeWindow } from "../shared/schema.ts";

// Start of the current LOCAL day (the user's "today"), not UTC. A UTC boundary
// would misattribute early-morning local usage to the previous day for users
// east of UTC (e.g. Asia/Shanghai).
export function localStartOfDay(now: Date): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

export function windowCutoff(window: TimeWindow, now: Date): number {
  const ms = now.getTime();
  switch (window) {
    case "today":
      return localStartOfDay(now);
    case "7d":
      return ms - 7 * 24 * 60 * 60 * 1000;
    case "30d":
      return ms - 30 * 24 * 60 * 60 * 1000;
  }
}

// Collapse the home directory to "~" so UI / logs don't leak the username.
export function tildePath(p: string): string {
  const home = homedir();
  return p.startsWith(home) ? "~" + p.slice(home.length) : p;
}
