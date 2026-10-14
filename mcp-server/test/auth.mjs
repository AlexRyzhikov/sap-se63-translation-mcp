// Regression tests for the two traps that cost a full debugging session on Windows:
//   1. SAP answers a rejected logon with HTTP 200 + its HTML logon page, not 401.
//   2. The .env parser must not strip a lone trailing quote (a quoted -File path).
import http from "node:http";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";

// No .env in play: real env vars win, and MCP_ENV_FILE points at a file that does not exist.
process.env.MCP_ENV_FILE = join(tmpdir(), "does-not-exist-auth-test.env");

const SAP_LOGON_PAGE =
  '<html><head><title>Logon - SAP Web Application Server</title></head><body>' +
  '<form method="post"><input type="text" id="sap-user" name="sap-user">' +
  '<input type="password" id="sap-password" name="sap-password"></form></body></html>';

let reply = { status: 200, body: SAP_LOGON_PAGE, type: "text/html" };
const sap = http.createServer((req, res) => {
  res.writeHead(reply.status, { "Content-Type": reply.type });
  res.end(reply.body);
});
await new Promise((ok) => sap.listen(0, ok));

process.env.SAP_URL = `http://127.0.0.1:${sap.address().port}`;
process.env.SAP_CLIENT = "100";
process.env.SAP_USER = "TESTUSER";
process.env.SAP_PASSWORD = "secret";

const { getConfig, unquoteEnvValue } = await import("../dist/config.js");
const { SapClient } = await import("../dist/sapClient.js");
const client = new SapClient(getConfig());

// 1. HTTP 200 + logon page -> a message that names the real causes, not "(not JSON)".
await assert.rejects(
  () => client.ping(),
  (e) => {
    assert.match(e.message, /HTML logon page/i, "should say SAP returned its logon page");
    assert.match(e.message, /expired/i, "should name the expired password as the likely cause");
    assert.match(e.message, /SICF/, "should also point at the SICF basic-auth setting");
    assert.doesNotMatch(e.message, /not JSON/, "the old unhelpful wording must be gone");
    return true;
  },
);
console.log("logon page on HTTP 200: detected");

// 2. A 401 whose body is not the logon page keeps the plain logon-failed hint.
reply = { status: 401, body: "<html>401</html>", type: "text/html" };
await assert.rejects(
  () => client.ping(),
  (e) => {
    assert.match(e.message, /HTTP 401/);
    assert.match(e.message, /Logon failed/i);
    return true;
  },
);
console.log("plain 401: unchanged");

// 3. The happy path still parses.
reply = {
  status: 200,
  type: "application/json",
  body: JSON.stringify({ system: "TST", client: "100", user: "TESTUSER", release: "758", logon_lang: "E", lxe_lang: "enUS", server_time: "now" }),
};
assert.equal((await client.ping()).system, "TST");
console.log("happy path: ok");

sap.close();

// 4. .env quoting: strip a matched pair, never a lone trailing quote. Getting this wrong
//    breaks  SAP_PASSWORD_CMD=pwsh -NoProfile -File "C:\Program Files\...\x.ps1"
assert.equal(unquoteEnvValue('"C:\\Program Files\\x.ps1"'), "C:\\Program Files\\x.ps1");
assert.equal(unquoteEnvValue("'secret-tool lookup service sap'"), "secret-tool lookup service sap");
assert.equal(
  unquoteEnvValue('pwsh -NoProfile -File "C:\\Program Files\\x.ps1"'),
  'pwsh -NoProfile -File "C:\\Program Files\\x.ps1"',
);
assert.equal(unquoteEnvValue('op read op://Private/SAP/password  '), "op read op://Private/SAP/password");
assert.equal(unquoteEnvValue('"'), '"');
console.log(".env quoting: ok");

console.log("\nAUTH TEST PASSED");
