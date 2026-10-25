// App settings: .env, the Zetaris install, and per-OS paths (macOS and Windows).

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Load ROOT/.env into process.env without overriding variables that are already set. */
export function loadDotEnv(file = join(ROOT, ".env")): void {
  for (const [k, v] of Object.entries(parseEnvFile(file))) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

/** Parse KEY=value lines. Values are never executed, unlike `source .env`. */
export function parseEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, "utf-8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if (/^".*"$|^'.*'$/.test(v)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, "");
    out[m[1]] = v;
  }
  return out;
}

export const sampleMode = () => process.env.SAMPLE_MODE === "true";

export interface ZetarisSettings {
  dir: string;
  jar: string;
  url: string;
  user: string;
  password: string;
}

/**
 * Find the zetaris-platform folder (ZETARIS_DIR, next to this repo, in the home folder or in
 * Downloads) and read the JDBC jar and admin login from it. Null when Zetaris isn't installed.
 */
export function zetarisSettings(): ZetarisSettings | null {
  const candidates = [
    process.env.ZETARIS_DIR,
    join(ROOT, "..", "zetaris-platform"),
    join(homedir(), "zetaris-platform"),
    join(homedir(), "Downloads", "zetaris-platform"),
  ].filter((d): d is string => !!d);
  const dir = candidates.find((d) => existsSync(join(d, "docker-compose.yml")));
  if (!dir) return null;
  const jdbc = join(dir, "jdbc");
  const jarName = existsSync(jdbc) ? readdirSync(jdbc).find((f) => /driver.*\.jar$/.test(f)) : undefined;
  if (!jarName) return null;
  const env = parseEnvFile(join(dir, ".env"));
  return {
    dir,
    jar: join(jdbc, jarName),
    url: process.env.ZETARIS_URL ?? `jdbc:zetaris:lightning@localhost:${env.DRIVER_PORT || "10000"}`,
    user: process.env.ZETARIS_USER ?? env.ZETARIS_ADMIN_EMAIL ?? "admin@zetaris.com",
    password: process.env.ZETARIS_PASSWORD ?? env.ZETARIS_ADMIN_PASSWORD ?? "",
  };
}
