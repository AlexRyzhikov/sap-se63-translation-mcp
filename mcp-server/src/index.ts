#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getConfig } from "./config.js";
import { SapClient, type SapText, type Scope } from "./sapClient.js";
import {
  buildWorklist, checkProposal, countByStatus, isUpperCaseOnly, listWorklists, loadWorklist,
  parseCsv, saveWorklist, worklistPath, type ItemStatus, type WorklistItem,
} from "./worklist.js";

const cfg = getConfig();
const sap = new SapClient(cfg);

const server = new McpServer({ name: "sap-se63-translation", version: "0.1.0" });

/* ---------- helpers ---------- */

const json = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });

const fail = (e: unknown) => ({
  isError: true,
  content: [{ type: "text" as const, text: e instanceof Error ? e.message : String(e) }],
});

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

const scopeShape = {
  package_name: z.string().optional().describe("ABAP package (devclass), e.g. ZQM_COMPLAINT"),
  include_subpackages: z.boolean().optional().describe("Also take objects of all sub-packages (default false)"),
  transport: z.string().optional().describe("Transport request; all objects of the request and its tasks"),
  objects: z
    .array(
      z.object({
        object: z.string().describe("R3TR type, e.g. DDLS, DDLX, DTEL, MSAG, CLAS, WAPA, SFPF; FORM = SE71 SAPscript form, TEXT = SO10 standard text"),
        obj_name: z.string().describe("Object name. TEXT: text name, optionally with text ID 'ZMY_TEXT,ST' (default ST)"),
      }),
    )
    .optional()
    .describe("Explicit R3TR objects"),
  object_types: z.array(z.string()).optional().describe("Filter by R3TR type, e.g. [\"DDLS\",\"DDLX\",\"MSAG\"]"),
};

function toScope(a: Scope): Scope {
  const s: Scope = {};
  if (a.package_name) s.package_name = a.package_name.toUpperCase();
  if (a.include_subpackages) s.include_subpackages = true;
  if (a.transport) s.transport = a.transport.toUpperCase();
  if (a.objects?.length) s.objects = a.objects.map((o) => ({ pgmid: "R3TR", object: o.object.toUpperCase(), obj_name: o.obj_name.toUpperCase() }));
  if (a.object_types?.length) s.object_types = a.object_types.map((t) => t.toUpperCase());
  if (!s.package_name && !s.transport && !s.objects) throw new Error("Give package_name, transport or objects.");
  return s;
}

function compactItem(i: WorklistItem) {
  return {
    id: i.id,
    status: i.status,
    object: `${i.object} ${i.obj_name}`,
    objtype: i.objtype,
    textkey: i.textkey,
    texttype: i.texttype,
    max_len: i.max_len,
    ...(isUpperCaseOnly(i.source) ? { upper_case: true } : {}),
    source: i.source,
    ...(i.existing ? { existing: i.existing } : {}),
    ...(i.proposal ? { proposal: i.proposal } : {}),
    ...(i.note ? { note: i.note } : {}),
  };
}

/* ---------- tools: SAP ---------- */

server.registerTool(
  "sap_ping",
  {
    title: "Test SAP connection",
    description: "Checks the connection to the SAP translation service (ZCL_MCP_TRANSL_HTTP) and returns system, client, user and release.",
    inputSchema: {},
  },
  async () => {
    try {
      return json({ ...(await sap.ping()), worklist_dir: cfg.worklistDir });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "sap_list_objects",
  {
    title: "List objects of a package or transport",
    description: "Lists the R3TR repository objects (CDS views DDLS, metadata extensions DDLX, data elements, message classes, classes, UI5 apps WAPA, ...) of a package and/or transport request.",
    inputSchema: scopeShape,
  },
  async (args) => {
    try {
      return json(await sap.listObjects(toScope(args)));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "sap_translation_status",
  {
    title: "Translation status",
    description: "Shows per object and target language whether it is fully translated in SE63 (status T). Use it to find out what is still missing before downloading.",
    inputSchema: {
      ...scopeShape,
      target_langs: z.array(z.string()).min(1).describe("Target languages: ISO (DE, EN, KO), SAP key (D) or LXE (deDE)"),
      source_lang: z.string().optional().describe("Source language; empty = original language of each object"),
    },
  },
  async (args) => {
    try {
      const res = await sap.status(toScope(args), args.target_langs, args.source_lang);
      // summarise per R3TR object and language
      const summary: Record<string, { object: string; target_lang: string; translated: number; open: number; open_objects: string[] }> = {};
      for (const s of res.status) {
        const k = `${s.object} ${s.obj_name}|${s.target_lang}`;
        summary[k] ??= { object: `${s.object} ${s.obj_name}`, target_lang: s.target_lang, translated: 0, open: 0, open_objects: [] };
        if (s.translated) summary[k].translated++;
        else {
          summary[k].open++;
          summary[k].open_objects.push(`${s.objtype} ${s.objname} (${s.status || "-"})`);
        }
      }
      return json({ se63_objects: res.count, objects: Object.values(summary), messages: res.messages });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "sap_download_translations",
  {
    title: "Download existing translations",
    description:
      "Reads all text pairs (source text + existing translation, max length, text type) for the scope and one target language from SAP (SE63 API) " +
      "and saves them as a local worklist (JSON + CSV for Excel). Returns the file name and counts. " +
      "Next steps: worklist_get -> translate -> worklist_set_translations -> sap_upload_translations.",
    inputSchema: {
      ...scopeShape,
      target_lang: z.string().describe("Target language: ISO (DE, EN, KO), SAP key (D) or LXE (deDE)"),
      source_lang: z.string().optional().describe("Source language; empty = original language of each object"),
      only_missing: z.boolean().optional().describe("Only texts without translation (default false = also existing ones, useful as glossary/review)"),
      file_name: z.string().optional().describe("Worklist file name (default: <scope>_<lang>_<timestamp>.json)"),
    },
  },
  async (args) => {
    try {
      const scope = toScope(args);
      const ping = await sap.ping();
      const list = await sap.listObjects(scope);
      if (!list.count) return json({ message: "No objects found for this scope.", scope });

      const texts: SapText[] = [];
      const messages: string[] = [];
      for (const part of chunk(list.objects, 20)) {
        const res = await sap.readTexts({ objects: part }, args.target_lang, {
          sourceLang: args.source_lang,
          onlyMissing: args.only_missing ?? false,
        });
        texts.push(...res.texts);
        messages.push(...res.messages);
      }

      const label = (scope.package_name ?? scope.transport ?? scope.objects?.[0]?.obj_name ?? "objects").replace(/[^A-Z0-9_]/gi, "_");
      const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 13);
      const fileName = args.file_name ?? `${label}_${args.target_lang.toUpperCase()}_${stamp}.json`;
      const path = worklistPath(cfg.worklistDir, fileName);
      const wl = buildWorklist(`${ping.system}/${ping.client}`, scope, args.target_lang, args.source_lang ?? "", texts);
      saveWorklist(path, wl);

      const byType: Record<string, number> = {};
      for (const t of texts) byType[t.object] = (byType[t.object] ?? 0) + 1;

      return json({
        file: path,
        csv: path.replace(/\.json$/, ".csv"),
        r3tr_objects: list.count,
        counts: countByStatus(wl),
        texts_per_object_type: byType,
        messages: messages.slice(0, 30),
        next: "Call worklist_get with filter 'missing' to get the texts to translate.",
      });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "sap_upload_translations",
  {
    title: "Upload translations to SAP",
    description:
      "Writes the proposals of a worklist (status 'proposed') to SAP via the SE63 API and records them in the transport. " +
      "Default is dry_run=true (SAP checks keys and lengths but writes nothing). " +
      "Only call with dry_run=false after the user has confirmed.",
    inputSchema: {
      file: z.string().describe("Worklist file (name or full path)"),
      transport: z.string().optional().describe("Transport request (or task). Required unless no_transport=true"),
      dry_run: z.boolean().optional().describe("Default true. false = really write to SAP"),
      ids: z.array(z.string()).optional().describe("Only these item ids (default: all with status 'proposed' or 'error')"),
      no_transport: z.boolean().optional().describe("Write without transport entry (only for local $TMP objects)"),
    },
  },
  async (args) => {
    try {
      const dryRun = args.dry_run ?? true;
      const path = worklistPath(cfg.worklistDir, args.file);
      const wl = loadWorklist(path);
      const idSet = args.ids ? new Set(args.ids) : undefined;
      const todo = wl.items.filter(
        (i) => i.proposal && (idSet ? idSet.has(i.id) : i.status === "proposed" || i.status === "error"),
      );
      if (!todo.length) return json({ message: "Nothing to upload (no items with a proposal).", counts: countByStatus(wl) });

      const key = (o: { objtype: string; objname: string; textkey: string }) => `${o.objtype}|${o.objname}|${o.textkey}`;
      const results = new Map<string, { result: string; message: string }>();
      const messages: string[] = [];
      let task = "";

      for (const part of chunk(todo, 200)) {
        const payload: SapText[] = part.map(({ id, existing, proposal, status, note, ...t }) => ({ ...t, target: proposal }));
        const res = await sap.writeTexts(payload, { transport: args.transport, dryRun, noTransport: args.no_transport });
        task = res.task || task;
        messages.push(...res.messages);
        for (const r of res.results) results.set(key(r), { result: r.result, message: r.message });
      }

      const summary: Record<string, number> = {};
      const problems: { id: string; source: string; proposal: string; result: string; message: string }[] = [];
      for (const item of todo) {
        const r = results.get(key(item)) ?? { result: "no_result", message: "SAP returned no result for this text" };
        summary[r.result] = (summary[r.result] ?? 0) + 1;
        if (!dryRun) {
          if (r.result === "ok" || r.result === "unchanged") {
            item.status = "written";
            item.note = "";
          } else if (r.result === "error" || r.result === "no_result") {
            item.status = "error";
            item.note = r.message;
          }
        }
        if (r.result !== "ok" && r.result !== "dry_run" && r.result !== "unchanged") {
          problems.push({ id: item.id, source: item.source, proposal: item.proposal, result: r.result, message: r.message });
        }
      }
      if (!dryRun) saveWorklist(path, wl);

      return json({
        dry_run: dryRun,
        task,
        results: summary,
        problems: problems.slice(0, 50),
        messages,
        counts: countByStatus(wl),
        ...(dryRun ? { next: "If OK, ask the user and call again with dry_run=false." } : {}),
      });
    } catch (e) {
      return fail(e);
    }
  },
);

/* ---------- tools: worklist ---------- */

server.registerTool(
  "worklist_list",
  {
    title: "List worklists",
    description: "Lists the local worklist files with counts per status.",
    inputSchema: {},
  },
  async () => json({ dir: cfg.worklistDir, worklists: listWorklists(cfg.worklistDir) }),
);

server.registerTool(
  "worklist_get",
  {
    title: "Get texts from a worklist",
    description:
      "Returns texts of a worklist page by page. filter: 'todo' (missing + error, default), 'missing', 'translated' (existing SAP translations – use as glossary), " +
      "'proposed', 'error', 'all'. Each item has id, source text, max_len, texttype, upper_case and existing translation.",
    inputSchema: {
      file: z.string(),
      filter: z.enum(["todo", "missing", "translated", "proposed", "written", "error", "all"]).optional(),
      offset: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(500).optional().describe("Default 100"),
      object_type: z.string().optional().describe("Only items of this R3TR type, e.g. MSAG"),
    },
  },
  async (args) => {
    try {
      const wl = loadWorklist(worklistPath(cfg.worklistDir, args.file));
      const filter = args.filter ?? "todo";
      const wanted: ItemStatus[] | null =
        filter === "all" ? null : filter === "todo" ? ["missing", "error"] : [filter as ItemStatus];
      let items = wl.items.filter((i) => !wanted || wanted.includes(i.status));
      if (args.object_type) items = items.filter((i) => i.object === args.object_type!.toUpperCase());
      const offset = args.offset ?? 0;
      const limit = args.limit ?? 100;
      const page = items.slice(offset, offset + limit);
      return json({
        target_lang: wl.target_lang,
        source_lang: wl.source_lang || "(original language per object)",
        total_matching: items.length,
        offset,
        returned: page.length,
        next_offset: offset + page.length < items.length ? offset + page.length : null,
        items: page.map(compactItem),
      });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "worklist_set_translations",
  {
    title: "Store translations in a worklist",
    description:
      "Stores translation proposals by item id (status -> 'proposed'). Checks max length (rejects too long texts), " +
      "placeholders (&1, &, {0}, %s), upper-case fields. Does NOT write to SAP – use sap_upload_translations for that.",
    inputSchema: {
      file: z.string(),
      items: z.array(z.object({ id: z.string(), text: z.string() })).min(1),
    },
  },
  async (args) => {
    try {
      const path = worklistPath(cfg.worklistDir, args.file);
      const wl = loadWorklist(path);
      const byId = new Map(wl.items.map((i) => [i.id, i]));
      const rejected: { id: string; error: string; source: string; max_len: number }[] = [];
      const warnings: { id: string; warnings: string[] }[] = [];
      let stored = 0;

      for (const { id, text } of args.items) {
        const item = byId.get(id);
        if (!item) {
          rejected.push({ id, error: "unknown id", source: "", max_len: 0 });
          continue;
        }
        const check = checkProposal(item, text);
        if (!check.ok) {
          rejected.push({ id, error: check.error!, source: item.source, max_len: item.max_len });
          continue;
        }
        item.proposal = check.text;
        item.status = "proposed";
        item.note = check.warnings.join("; ");
        if (check.warnings.length) warnings.push({ id, warnings: check.warnings });
        stored++;
      }
      saveWorklist(path, wl);
      return json({ stored, rejected, warnings, counts: countByStatus(wl) });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "worklist_import_csv",
  {
    title: "Import reviewed CSV",
    description:
      "Imports the 'proposal' column of a worklist CSV that a human edited in Excel (matched by id). Same checks as worklist_set_translations.",
    inputSchema: {
      file: z.string().describe("Worklist JSON file"),
      csv_path: z.string().optional().describe("CSV path (default: the worklist's own .csv)"),
    },
  },
  async (args) => {
    try {
      const path = worklistPath(cfg.worklistDir, args.file);
      const wl = loadWorklist(path);
      const rows = parseCsv(readFileSync(args.csv_path ?? path.replace(/\.json$/, ".csv"), "utf8"));
      const byId = new Map(wl.items.map((i) => [i.id, i]));
      let stored = 0;
      const rejected: { id: string; error: string }[] = [];
      for (const row of rows) {
        const item = byId.get(row.id);
        const text = row.proposal ?? "";
        if (!item || !text || text === item.proposal || (item.status === "written" && text === item.proposal)) continue;
        const check = checkProposal(item, text);
        if (!check.ok) {
          rejected.push({ id: row.id, error: check.error! });
          continue;
        }
        item.proposal = check.text;
        item.status = "proposed";
        item.note = check.warnings.join("; ");
        stored++;
      }
      saveWorklist(path, wl);
      return json({ rows: rows.length, stored, rejected, counts: countByStatus(wl) });
    } catch (e) {
      return fail(e);
    }
  },
);

/* ---------- prompt ---------- */

server.registerPrompt(
  "translate_sap_package",
  {
    title: "Translate an SAP package",
    description: "Guided workflow: download, translate with Claude, review, upload.",
    argsSchema: {
      package_name: z.string().describe("ABAP package"),
      target_lang: z.string().describe("Target language, e.g. DE, EN, KO"),
      transport: z.string().optional().describe("Transport request for the translations"),
    },
  },
  ({ package_name, target_lang, transport }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: `Translate the SAP package ${package_name} into ${target_lang}.

Workflow:
1. sap_translation_status for the package and ${target_lang} – show me a short overview.
2. sap_download_translations (only_missing=false, so existing translations can serve as glossary).
3. worklist_get filter='translated' – learn the existing terminology (keep it consistent).
4. worklist_get filter='todo' page by page; translate each text and store with worklist_set_translations.
5. Show me a summary + the warnings. Wait for my OK.
6. sap_upload_translations dry_run=true${transport ? ` transport=${transport}` : ""}, then after my OK dry_run=false.

Translation rules:
- Respect max_len strictly (SAP field length). Use standard SAP abbreviations if needed (e.g. "Bez." / "Desc.").
- Keep placeholders exactly: &1 &2 & {0} %s, and keep a trailing colon if the source has one.
- Use the SAP terminology of the module (QM: Prüflos/inspection lot, Merkmal/characteristic, Meldung/notification ...).
- texttype hints: XFLD/XTIT field label/title, XBUT button, XMSG/MESS message, XTOL tooltip, YINS instruction.
- Field labels: short, no sentence. Messages: full sentence, same tone as source.
- Upper-case-only fields: write in upper case.
- SAPscript (object FORM = SE71, TEXT = SO10): one item = one paragraph, max_len 0 = no limit (lines are re-wrapped in SAP).
  Keep symbols &VBDKA-VBELN& / &PAGE(3)&, character formats <B>…</> and tabs ,, exactly; texttype = paragraph format.`,
        },
      },
    ],
  }),
);

/* ---------- start ---------- */

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`sap-se63-translation MCP server running (SAP ${cfg.url || "<not configured>"}, worklists in ${cfg.worklistDir})`);
