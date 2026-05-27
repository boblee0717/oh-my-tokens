import { homedir } from "node:os";

export function localStartOfDay(now) {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

export function windowCutoff(window, now) {
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

export function tildePath(p) {
  const home = homedir();
  return p.startsWith(home) ? "~" + p.slice(home.length) : p;
}
