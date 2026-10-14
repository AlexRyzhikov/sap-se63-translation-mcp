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

/**
 * Strips ONE pair of surrounding quotes – only if the value really starts *and* ends
 * with the same quote character. A value that merely ends in a quote must stay intact:
 *   SAP_PASSWORD_CMD=pwsh -NoProfile -File "C:\Program Files\...\windows-password.ps1"
 * Removing that closing quote alone would hand a broken command to the shell.
 */
export function unquoteEnvValue(value: string): string {
  const v = value.trimEnd();
  const q = v[0];
  return v.length >= 2 && (q === '"' || q === "'") && v.endsWith(q) ? v.slice(1, -1) : v;
}

function loadDotEnv(): void {
  const candidates = [envFilePath()];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (!m || line.trim().startsWith("#")) continue;
      const value = unquoteEnvValue(m[2]);
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

const firstLine = (s: string) => s.trim().split(/\r?\n/)[0].slice(0, 200);

/**
 * How to store the password on this platform. Also used for HTTP auth errors, so the
 * message always names the command the user actually needs.
 */
export function passwordStoreHint(cfg: Config): string {
  const user = cfg.user || "<SAP_USER>";
  switch (process.platform) {
    case "darwin":
      return `Store it once in the macOS keychain:  security add-generic-password -U -s ${cfg.keychainService} -a ${user} -w`;
    case "win32":
      return (
        `Store it once with the DPAPI helper (needs PowerShell 7):  ` +
        `pwsh -NoProfile -File mcp-server\\scripts\\windows-password.ps1 -Store -User ${user}  ` +
        `– then set SAP_PASSWORD_CMD in .env (see README → Windows).`
      );
    default:
      return `Set SAP_PASSWORD_CMD in .env to a command that prints the password, e.g.  secret-tool lookup service ${cfg.keychainService}`;
  }
}

/**
 * Password lookup, most secure first. The password is never written to disk by this server.
 *  1. macOS keychain:  security add-generic-password -s sap-se63-mcp -a <SAP_USER> -w
 *  2. SAP_PASSWORD_CMD: any command that prints it (DPAPI helper on Windows, 1Password CLI, pass, ...)
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
      const { stdout, stderr } = await execP(cfg.passwordCmd, { windowsHide: true });
      if (stdout.trim()) return (cachedPassword = stdout.replace(/\r?\n$/, ""));
      // No stdout does not mean no error. A PowerShell script that dies in Constrained
      // Language Mode (AppLocker / WDAC) still exits 0 and writes only to stderr, so
      // pass stderr on – it names the real cause instead of just "printed nothing".
      errors.push(`SAP_PASSWORD_CMD printed nothing${stderr.trim() ? ` – stderr: ${firstLine(stderr)}` : ""}`);
    } catch (e) {
      const err = e as Error & { stderr?: string };
      errors.push(`SAP_PASSWORD_CMD failed: ${firstLine(err.stderr?.trim() ? err.stderr : err.message)}`);
    }
  }
  if (cfg.password) return (cachedPassword = cfg.password);

  throw new Error(`No SAP password found (${errors.join("; ") || "nothing configured"}). ${passwordStoreHint(cfg)}`);
}

/** Forget the cached password, e.g. after HTTP 401 (password changed). */
export function clearPasswordCache(): void {
  cachedPassword = undefined;
}
