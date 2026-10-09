#!/usr/bin/env node
/**
 * Setup wizard:  npm run setup  [-- --url https://host:44300 --client 100 --user MYUSER ...]
 *
 *  1. asks for the connection data (or takes it from flags)      -> writes mcp-server/.env (no password!)
 *  2. stores the password in the OS keychain (macOS)             -> asked by the OS, never shown, never in a file
 *  3. tests the connection (ping)
 *  4. registers the server in Claude Desktop                     -> merges claude_desktop_config.json (with backup)
 *
 * Non-interactive (e.g. when Claude runs it): pass all flags plus --yes. The password step is then
 * skipped and the exact keychain command is printed for the user to run in their own terminal.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const SERVER_NAME = "sap-se63-translation";
const here = dirname(fileURLToPath(import.meta.url));
const projectDir = resolve(here, "..");
const entryFile = join(projectDir, "dist", "index.js");
const envFile = process.env.MCP_ENV_FILE ?? join(projectDir, ".env");

/* ---------- args ---------- */

type Flags = Record<string, string | boolean>;
function parseArgs(argv: string[]): Flags {
  const f: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const [k, inline] = a.slice(2).split("=", 2);
    if (inline !== undefined) f[k] = inline;
    else if (argv[i + 1] && !argv[i + 1].startsWith("--")) f[k] = argv[++i];
    else f[k] = true;
  }
  return f;
}
const flags = parseArgs(process.argv.slice(2));
const interactive = process.stdin.isTTY && !flags.yes;

if (flags.help) {
  console.log(`Usage: npm run setup [-- options]

  --url <https://host:port>   SAP system (HTTPS port from SMICM > Services)
  --client <nnn>              SAP client
  --user <USER>               SAP user
  --language <EN>             logon language for messages (default EN)
  --self-signed               allow self-signed certificates (local/test systems only)
  --worklist-dir <path>       where worklists are stored (default ~/sap-translation-worklists)
  --service-path <path>       ICF path (default /sap/bc/zmcp_transl)
  --no-claude                 do not touch the Claude Desktop config
  --no-test                   skip the connection test
  --yes                       non-interactive: take flags / existing .env, never prompt
`);
  process.exit(0);
}

/* ---------- helpers ---------- */

function readEnv(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && !line.trim().startsWith("#")) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

const rl = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : undefined;
async function ask(question: string, def: string): Promise<string> {
  if (!rl) return def;
  const a = (await rl.question(`${question}${def ? ` [${def}]` : ""}: `)).trim();
  return a || def;
}
const ok = (m: string) => console.log(`  ✔ ${m}`);
const warn = (m: string) => console.log(`  ⚠ ${m}`);
const step = (m: string) => console.log(`\n${m}`);

function claudeConfigPath(): string {
  switch (platform()) {
    case "darwin":
      return join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
    case "win32":
      return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
    default:
      return join(homedir(), ".config", "Claude", "claude_desktop_config.json");
  }
}

/* ---------- main ---------- */

async function main() {
  console.log("SAP SE63 translation MCP server – setup");
  if (!existsSync(entryFile)) {
    console.error(`\n✖ ${entryFile} not found. Run "npm run build" first.`);
    process.exit(1);
  }

  // 1. connection data
  step("1/4 Connection data (saved to .env – no password)");
  const cur = readEnv(envFile);
  const str = (k: string) => (typeof flags[k] === "string" ? (flags[k] as string) : undefined);
  const url = (str("url") ?? (await ask("SAP URL (https://host:port)", cur.SAP_URL ?? ""))).replace(/\/+$/, "");
  const client = str("client") ?? (await ask("Client", cur.SAP_CLIENT ?? "100"));
  const user = (str("user") ?? (await ask("SAP user", cur.SAP_USER ?? ""))).toUpperCase();
  const language = str("language") ?? cur.SAP_LANGUAGE ?? "EN";
  const servicePath = str("service-path") ?? cur.SAP_SERVICE_PATH ?? "/sap/bc/zmcp_transl";
  const selfSignedDefault = flags["self-signed"] ? "y" : /^(1|true|yes)$/i.test(cur.SAP_ALLOW_SELF_SIGNED ?? "") || /localhost|127\.0\.0\.1/.test(url) ? "y" : "n";
  const selfSigned = /^y/i.test(flags["self-signed"] ? "y" : await ask("Allow self-signed certificate? (y/n, only for local/test systems)", selfSignedDefault));
  const worklistDir = str("worklist-dir") ?? (await ask("Worklist folder", cur.WORKLIST_DIR ?? "~/sap-translation-worklists"));

  if (!/^https?:\/\/[^/]+/.test(url) || !user) {
    console.error("\n✖ SAP URL and user are required (e.g. --url https://myhost:44300 --user MYUSER).");
    process.exit(1);
  }

  const env = [
    "# Written by `npm run setup`. No password here – it lives in the OS keychain.",
    `SAP_URL=${url}`,
    `SAP_CLIENT=${client}`,
    `SAP_USER=${user}`,
    `SAP_LANGUAGE=${language}`,
    `SAP_SERVICE_PATH=${servicePath}`,
    `SAP_ALLOW_SELF_SIGNED=${selfSigned}`,
    `WORKLIST_DIR=${worklistDir}`,
    ...(cur.SAP_PASSWORD_CMD ? [`SAP_PASSWORD_CMD=${cur.SAP_PASSWORD_CMD}`] : []),
    ...(cur.SAP_KEYCHAIN_SERVICE ? [`SAP_KEYCHAIN_SERVICE=${cur.SAP_KEYCHAIN_SERVICE}`] : []),
    "",
  ].join("\n");
  writeFileSync(envFile, env, { encoding: "utf8", mode: 0o600 });
  ok(`saved ${envFile}`);

  // 2. password
  step("2/4 Password");
  const service = cur.SAP_KEYCHAIN_SERVICE ?? "sap-se63-mcp";
  const keychainCmd = `security add-generic-password -U -s ${service} -a ${user} -w`;
  if (cur.SAP_PASSWORD_CMD) {
    ok("SAP_PASSWORD_CMD is set – using your password manager");
  } else if (platform() === "darwin") {
    const has = spawnSync("/usr/bin/security", ["find-generic-password", "-s", service, "-a", user], { stdio: "ignore" }).status === 0;
    if (has && !(await ask("Password already in keychain. Replace it? (y/n)", "n")).match(/^y/i)) {
      ok(`keychain item "${service}" / ${user} found`);
    } else if (interactive) {
      console.log("  macOS will now ask for the SAP password (input is hidden):");
      rl?.pause();
      const r = spawnSync("/usr/bin/security", ["add-generic-password", "-U", "-s", service, "-a", user, "-w"], { stdio: "inherit" });
      rl?.resume();
      r.status === 0 ? ok("password stored in the macOS keychain") : warn(`keychain command failed – run it yourself:\n      ${keychainCmd}`);
    } else {
      warn(`run this in YOUR terminal (it asks for the password, hidden):\n      ${keychainCmd}`);
    }
  } else {
    warn(
      "No keychain support on this OS. Set SAP_PASSWORD_CMD in .env to a command that prints the password,\n" +
        "      e.g.  SAP_PASSWORD_CMD=op read op://Private/SAP/password   (1Password CLI)\n" +
        "      or    SAP_PASSWORD_CMD=secret-tool lookup service sap-se63-mcp   (Linux)",
    );
  }

  // 3. connection test
  step("3/4 Connection test");
  if (flags["no-test"] === true) {
    warn("skipped (--no-test)");
  } else {
    for (const [k, v] of Object.entries(readEnv(envFile))) process.env[k] = v;
    try {
      const { getConfig } = await import("./config.js");
      const { SapClient } = await import("./sapClient.js");
      const p = await new SapClient(getConfig()).ping();
      ok(`connected: system ${p.system}, client ${p.client}, user ${p.user}, release ${p.release}`);
    } catch (e) {
      warn(`${(e as Error).message}\n      (you can re-run "npm run setup" any time)`);
    }
  }

  // 4. Claude Desktop
  step("4/4 Claude Desktop");
  const cfgPath = claudeConfigPath();
  const entry = { command: process.execPath, args: [entryFile] };
  if (flags["no-claude"] === true) {
    warn("skipped (--no-claude). Add this to claude_desktop_config.json → mcpServers:");
    console.log(JSON.stringify({ [SERVER_NAME]: entry }, null, 2));
  } else {
    let cfg: { mcpServers?: Record<string, unknown> } & Record<string, unknown> = {};
    if (existsSync(cfgPath)) {
      try {
        cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
      } catch {
        console.error(`✖ ${cfgPath} is not valid JSON – fix it first, nothing was changed.`);
        process.exit(1);
      }
      copyFileSync(cfgPath, `${cfgPath}.bak`);
    } else {
      mkdirSync(dirname(cfgPath), { recursive: true });
    }
    cfg.mcpServers = { ...(cfg.mcpServers ?? {}), [SERVER_NAME]: entry };
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n", "utf8");
    ok(`registered "${SERVER_NAME}" in ${cfgPath}${existsSync(`${cfgPath}.bak`) ? " (backup: .bak)" : ""}`);
    ok(`node: ${process.execPath}`);
  }

  console.log(`
Done. Next:
  • Quit Claude Desktop completely (⌘Q / Exit) and start it again.
  • In a chat: "Ping SAP".
  • Claude Code users instead:  claude mcp add ${SERVER_NAME} -- "${process.execPath}" "${entryFile}"
`);
  rl?.close();
}

main().catch((e) => {
  console.error(`✖ ${(e as Error).message}`);
  process.exit(1);
});
