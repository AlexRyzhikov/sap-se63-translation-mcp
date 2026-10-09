// End-to-end test: mock SAP backend (same JSON contract as ZCL_MCP_TRANSL_API) + real MCP client.
import http from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/* ---------- mock SAP ---------- */
const db = [
  { object: "MSAG", obj_name: "ZQM_MSG", custmnr: "999999", objtype: "MESS", objname: "ZQM_MSG", textkey: "001", texttype: "", max_len: 73, uppcase: "0", source: "Inspection lot &1 not found", target: "" },
  { object: "MSAG", obj_name: "ZQM_MSG", custmnr: "999999", objtype: "MESS", objname: "ZQM_MSG", textkey: "002", texttype: "", max_len: 73, uppcase: "0", source: "Complaint saved", target: "Reklamation gesichert" },
  { object: "DTEL", obj_name: "ZQM_DE_LOT", custmnr: "999999", objtype: "DTEL", objname: "ZQM_DE_LOT", textkey: "SCRTEXT_S", texttype: "", max_len: 10, uppcase: "0", source: "Insp. lot", target: "" },
  { object: "DDLS", obj_name: "ZI_QM_TANA", custmnr: "999999", objtype: "DDLS", objname: "ZI_QM_TANA", textkey: "ZI_QM_TANA$ENDUSERTEXT", texttype: "XTIT", max_len: 60, uppcase: "0", source: "Complaint", target: "" },
];
const writes = [];
const auth = "Basic " + Buffer.from("TESTUSER:secret").toString("base64");

const sapServer = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const send = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (req.headers.authorization !== auth) { res.writeHead(401); return res.end("<html>401</html>"); }
    const url = new URL(req.url, "http://x");
    assert.equal(url.searchParams.get("sap-client"), "100");
    const action = url.pathname.replace("/sap/bc/zmcp_transl/", "");
    const r = body ? JSON.parse(body) : {};
    const lang = (l) => (l?.length === 4 ? l : { DE: "deDE", EN: "enUS", D: "deDE", E: "enUS" }[l?.toUpperCase()] ?? "deDE");
    switch (action) {
      case "ping": return send(200, { system: "JWT", client: "100", user: "TESTUSER", release: "758", logon_lang: "E", lxe_lang: "enUS", server_time: "now" });
      case "list_objects": {
        const objs = [...new Map(db.map((t) => [t.object + t.obj_name, { pgmid: "R3TR", object: t.object, obj_name: t.obj_name, devclass: "ZQM" }])).values()];
        const out = r.objects ? objs.filter((o) => r.objects.some((x) => x.obj_name === o.obj_name)) : objs;
        return send(200, { count: out.length, objects: out });
      }
      case "status": return send(200, { count: db.length, status: db.map((t) => ({ object: t.object, obj_name: t.obj_name, objtype: t.objtype, objname: t.objname, source_lang: "enUS", target_lang: lang(r.target_langs[0]), status: t.target ? "T" : "N", translated: !!t.target })), messages: [] });
      case "read_texts": {
        const names = new Set((r.objects ?? []).map((o) => o.obj_name));
        const texts = db.filter((t) => names.has(t.obj_name) && (!r.only_missing || !t.target))
          .map((t) => ({ ...t, source_lang: "enUS", target_lang: lang(r.target_lang) }));
        return send(200, { object_count: names.size, text_count: texts.length, truncated: false, texts, messages: [] });
      }
      case "write_texts": {
        if (!r.transport && !r.no_transport && !r.dry_run) return send(400, { error: "Give a transport request" });
        const results = r.texts.map((t) => {
          const row = db.find((d) => d.objname === t.objname && d.textkey === t.textkey);
          if (!row) return { objtype: t.objtype, objname: t.objname, textkey: t.textkey, result: "error", message: "Text key not found" };
          if (t.target.length > row.max_len) return { objtype: t.objtype, objname: t.objname, textkey: t.textkey, result: "error", message: "Too long" };
          if (!r.dry_run) { row.target = t.target; writes.push(t); }
          return { objtype: t.objtype, objname: t.objname, textkey: t.textkey, result: r.dry_run ? "dry_run" : "ok", message: "" };
        });
        return send(200, { dry_run: !!r.dry_run, written: results.filter((x) => x.result === "ok").length, errors: 0, task: r.transport ? "JWTK900124" : "", results, messages: [] });
      }
      default: return send(404, { error: "Unknown action" });
    }
  });
});
await new Promise((ok) => sapServer.listen(0, ok));
const port = sapServer.address().port;

/* ---------- MCP client ---------- */
const wlDir = mkdtempSync(join(tmpdir(), "wl-"));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/index.js"],
  env: { ...process.env, SAP_URL: `http://127.0.0.1:${port}`, SAP_CLIENT: "100", SAP_USER: "TESTUSER", SAP_PASSWORD_CMD: "printf secret", WORKLIST_DIR: wlDir, MCP_ENV_FILE: "/nonexistent" },
  stderr: "pipe",
});
const client = new Client({ name: "e2e", version: "1" });
await client.connect(transport);

const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content[0].text;
  if (r.isError) throw new Error(`${name}: ${text}`);
  return JSON.parse(text);
};

const tools = (await client.listTools()).tools.map((t) => t.name).sort();
console.log("tools:", tools.join(", "));
assert.equal(tools.length, 9);
assert.equal((await client.listPrompts()).prompts[0].name, "translate_sap_package");

const ping = await call("sap_ping");
assert.equal(ping.system, "JWT");

const st = await call("sap_translation_status", { package_name: "zqm", target_langs: ["DE"] });
assert.equal(st.se63_objects, 4);

const dl = await call("sap_download_translations", { package_name: "zqm", target_lang: "DE", file_name: "test" });
console.log("download:", dl.counts);
assert.equal(dl.counts.total, 4);
assert.equal(dl.counts.missing, 3);
assert.equal(dl.counts.translated, 1);

const glossary = await call("worklist_get", { file: "test", filter: "translated" });
assert.equal(glossary.items[0].existing, "Reklamation gesichert");

const todo = await call("worklist_get", { file: "test" });
assert.equal(todo.total_matching, 3);
const id = (key) => todo.items.find((i) => i.textkey === key).id;

const set = await call("worklist_set_translations", {
  file: "test",
  items: [
    { id: id("001"), text: "Prüflos nicht gefunden" }, //            placeholder missing -> warning
    { id: id("SCRTEXT_S"), text: "Prüflosnummer lang" }, //          18 > 10 -> rejected
    { id: id("ZI_QM_TANA$ENDUSERTEXT"), text: "Reklamation" },
  ],
});
console.log("set:", { stored: set.stored, rejected: set.rejected.map((r) => r.error), warnings: set.warnings.map((w) => w.warnings) });
assert.equal(set.stored, 2);
assert.equal(set.rejected.length, 1);
assert.match(set.warnings[0].warnings[0], /placeholders differ/);

// fix via CSV import (human review in Excel)
const csvPath = join(wlDir, "test.csv");
const csv = readFileSync(csvPath, "utf8");
assert.ok(csv.startsWith("﻿"));
const fixed = csv.split("\r\n").map((line) => {
  if (line.startsWith(id("001") + ";")) return line.replace("Prüflos nicht gefunden", "Prüflos &1 nicht gefunden");
  if (line.startsWith(id("SCRTEXT_S") + ";")) return line.replace(/;([^;]*)$/, ";").replace(/;;$/, ";Prüflos;");
  return line;
}).join("\r\n");
writeFileSync(csvPath, fixed);
const imp = await call("worklist_import_csv", { file: "test" });
console.log("csv import:", imp);
assert.equal(imp.counts.proposed, 3);

const dry = await call("sap_upload_translations", { file: "test", transport: "JWTK900123" });
console.log("dry run:", dry.results);
assert.equal(dry.dry_run, true);
assert.equal(writes.length, 0);

const up = await call("sap_upload_translations", { file: "test", transport: "JWTK900123", dry_run: false });
console.log("upload:", up.results, "task", up.task);
assert.equal(up.results.ok, 3);
assert.equal(writes.length, 3);
assert.equal(up.counts.written, 3);
assert.equal(db[0].target, "Prüflos &1 nicht gefunden");

const noTr = await client.callTool({ name: "sap_upload_translations", arguments: { file: "test", ids: [id("001")], dry_run: false } });
assert.ok(noTr.isError, "upload without transport must fail");

const list = await call("worklist_list");
assert.equal(list.worklists[0].written, 3);

await client.close();
sapServer.close();
// Regression: UPPCASE='X' (as on DDLX labels) must NOT force upper case; all-caps source does.
const { checkProposal } = await import("../dist/worklist.js");
const base = { max_len: 255, uppcase: "X", source: "Preiselement" };
assert.equal(checkProposal(base, "Price element").text, "Price element");
assert.equal(checkProposal({ ...base, uppcase: "", source: "ORDER TYPE" }, "Auftragsart").text, "AUFTRAGSART");
console.log("upper-case regression: ok");

console.log("\nALL TESTS PASSED");
