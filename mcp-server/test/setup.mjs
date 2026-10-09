// Test for `npm run setup` (non-interactive): .env written without password, ping OK,
// Claude Desktop config merged (other servers kept, backup created).
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

if (process.platform === "win32") {
  console.log("setup test skipped on Windows");
  process.exit(0);
}

const auth = "Basic " + Buffer.from("TESTUSER:secret").toString("base64");
const sap = http.createServer((req, res) => {
  res.writeHead(req.headers.authorization === auth ? 200 : 401, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ system: "TST", client: "100", user: "TESTUSER", release: "758", logon_lang: "E", lxe_lang: "enUS", server_time: "now" }));
});
await new Promise((ok) => sap.listen(0, ok));
const port = sap.address().port;

const home = mkdtempSync(join(tmpdir(), "home-"));
const envFile = join(home, "test.env");
// password manager command is kept from an existing .env
writeFileSync(envFile, "SAP_PASSWORD_CMD=printf secret\n");

// existing Claude config with another server
const cfgDir = process.platform === "darwin" ? join(home, "Library", "Application Support", "Claude") : join(home, ".config", "Claude");
mkdirSync(cfgDir, { recursive: true });
const cfgFile = join(cfgDir, "claude_desktop_config.json");
writeFileSync(cfgFile, JSON.stringify({ mcpServers: { other: { command: "x" } }, preferences: { a: 1 } }));

// async spawn: the mock SAP server runs in this process and must keep answering
const r = await new Promise((done) => {
  const p = spawn(
    process.execPath,
    ["dist/setup.js", "--yes", "--url", `http://127.0.0.1:${port}/`, "--client", "100", "--user", "testuser", "--worklist-dir", join(home, "wl")],
    { env: { ...process.env, HOME: home, MCP_ENV_FILE: envFile } },
  );
  let stdout = "", stderr = "";
  p.stdout.on("data", (d) => (stdout += d));
  p.stderr.on("data", (d) => (stderr += d));
  const t = setTimeout(() => p.kill(), 30_000);
  p.on("close", (status) => { clearTimeout(t); done({ status, stdout, stderr }); });
});
sap.close();
console.log(r.stdout);
if (r.status !== 0) console.error(r.stderr);
assert.equal(r.status, 0);

const env = readFileSync(envFile, "utf8");
assert.match(env, /SAP_URL=http:\/\/127\.0\.0\.1:\d+\n/);
assert.match(env, /SAP_USER=TESTUSER/);
assert.match(env, /SAP_PASSWORD_CMD=printf secret/);
assert.doesNotMatch(env, /SAP_PASSWORD=/);
assert.match(r.stdout, /connected: system TST/);

const cfg = JSON.parse(readFileSync(cfgFile, "utf8"));
assert.equal(cfg.mcpServers.other.command, "x");
assert.equal(cfg.preferences.a, 1);
assert.equal(cfg.mcpServers["sap-se63-translation"].command, process.execPath);
assert.match(cfg.mcpServers["sap-se63-translation"].args[0], /dist[\\/]index\.js$/);
assert.ok(existsSync(cfgFile + ".bak"));

console.log("SETUP TEST PASSED");
