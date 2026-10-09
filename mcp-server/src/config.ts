import { exec, execFile } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Minimal .env loader (no dependency). Real env vars win over the file. */
/** Location of the .env file: MCP_ENV_FILE or mcp-server/.env (next to package.json). */
export function envFilePath(): string {
  return process.env.MCP_ENV_FILE ?? join(dirname(fileURLToPath(import.meta.url)), "..", ".env");
}

function loadDotEnv(): void {
  const candidates = [envFilePath()];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (!m || line.trim().startsWith("#")) continue;
      const value = m[2].replace(/^["']|["']$/g, "");
      if (process.env[m[1]] === undefined) process.env[m[1]] = value;
    }
    break;
  }
}

function expandHome(p: string): string {
  return p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
}

loadDotEnv();

export interface Config {
  url: string;
  client: string;
  user: string;
  /** Only for tests / CI. Prefer the keychain or SAP_PASSWORD_CMD. */
  password: string;
  /** Shell command that prints the password, e.g. `op read op://Private/SAP/password` */
  passwordCmd: string;
  /** macOS keychain item (service name); account = SAP_USER */
  keychainService: string;
  language: string;
  servicePath: string;
  allowSelfSigned: boolean;
  worklistDir: string;
}

export function getConfig(): Config {
  const url = (process.env.SAP_URL ?? "").replace(/\/+$/, "");
  return {
    url,
    client: process.env.SAP_CLIENT ?? "",
    user: process.env.SAP_USER ?? "",
    password: process.env.SAP_PASSWORD ?? "",
    passwordCmd: process.env.SAP_PASSWORD_CMD ?? "",
    keychainService: process.env.SAP_KEYCHAIN_SERVICE ?? "sap-se63-mcp",
    language: process.env.SAP_LANGUAGE ?? "EN",
    servicePath: (process.env.SAP_SERVICE_PATH ?? "/sap/bc/zmcp_transl").replace(/\/+$/, ""),
    allowSelfSigned: /^(1|true|yes)$/i.test(process.env.SAP_ALLOW_SELF_SIGNED ?? ""),
    worklistDir: resolve(expandHome(process.env.WORKLIST_DIR ?? join(homedir(), "sap-translation-worklists"))),
  };
}

export function assertSapConfig(cfg: Config): void {
  const missing = (["url", "user"] as const).filter((k) => !cfg[k]);
  if (missing.length) {
    throw new Error(
      `SAP connection not configured: missing ${missing.map((m) => "SAP_" + m.toUpperCase()).join(", ")}. ` +
        `Set them in mcp-server/.env or the MCP server env.`,
    );
  }
}

const execFileP = promisify(execFile);
const execP = promisify(exec); // uses the platform shell: /bin/sh on macOS/Linux, cmd.exe on Windows
let cachedPassword: string | undefined;

/**
 * Password lookup, most secure first. The password is never written to disk by this server.
 *  1. macOS keychain:  security add-generic-password -s sap-se63-mcp -a <SAP_USER> -w
 *  2. SAP_PASSWORD_CMD: any command that prints it (1Password CLI, pass, ...)
 *  3. SAP_PASSWORD env var (tests only)
 */
export async function resolvePassword(cfg: Config): Promise<string> {
  if (cachedPassword) return cachedPassword;
  const errors: string[] = [];

  if (process.platform === "darwin") {
    try {
      const { stdout } = await execFileP("/usr/bin/security", [
        "find-generic-password", "-s", cfg.keychainService, "-a", cfg.user, "-w",
      ]);
      if (stdout.trim()) return (cachedPassword = stdout.replace(/\r?\n$/, ""));
    } catch {
      errors.push(`no keychain item "${cfg.keychainService}" for account "${cfg.user}"`);
    }
  }
  if (cfg.passwordCmd) {
    try {
      const { stdout } = await execP(cfg.passwordCmd, { windowsHide: true });
      if (stdout.trim()) return (cachedPassword = stdout.replace(/\r?\n$/, ""));
      errors.push("SAP_PASSWORD_CMD printed nothing");
    } catch (e) {
      errors.push(`SAP_PASSWORD_CMD failed: ${(e as Error).message.split("\n")[0]}`);
    }
  }
  if (cfg.password) return (cachedPassword = cfg.password);

  throw new Error(
    `No SAP password found (${errors.join("; ") || "nothing configured"}). ` +
      `Store it once in the macOS keychain:  security add-generic-password -s ${cfg.keychainService} -a ${cfg.user || "<SAP_USER>"} -w`,
  );
}

/** Forget the cached password, e.g. after HTTP 401 (password changed). */
export function clearPasswordCache(): void {
  cachedPassword = undefined;
}
