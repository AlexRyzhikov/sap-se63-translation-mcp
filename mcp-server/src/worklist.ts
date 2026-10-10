import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, renameSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import type { SapText, Scope } from "./sapClient.js";

/**
 * A worklist is a local JSON file with all text pairs of one download.
 * Flow: download (from SAP) -> proposals (by Claude or a human via CSV) -> upload (to SAP).
 * Keeping the texts in a file means: big packages do not flood the chat,
 * a human can review in Excel, and the upload is reproducible.
 */

export type ItemStatus =
  | "missing" //    no translation in SAP yet
  | "translated" // translation exists in SAP (left alone unless a proposal is set)
  | "proposed" //   new proposal stored, not yet in SAP
  | "written" //    proposal written to SAP
  | "error"; //     last upload failed for this item

export interface WorklistItem extends SapText {
  id: string;
  existing: string; // target text that was in SAP at download time
  proposal: string; // new target text (Claude / human)
  status: ItemStatus;
  note: string; // warnings / errors
}

export interface Worklist {
  version: 1;
  created: string;
  updated: string;
  system: string;
  scope: Scope;
  target_lang: string;
  source_lang: string;
  items: WorklistItem[];
}

export function worklistPath(dir: string, file: string): string {
  if (isAbsolute(file)) return file;
  const name = file.endsWith(".json") ? file : `${file}.json`;
  return join(dir, basename(name));
}

export function saveWorklist(path: string, wl: Worklist): void {
  wl.updated = new Date().toISOString();
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(wl, null, 2), "utf8");
  renameSync(tmp, path); // atomic replace
  writeFileSync(path.replace(/\.json$/, ".csv"), toCsv(wl), "utf8");
}

export function loadWorklist(path: string): Worklist {
  const wl = JSON.parse(readFileSync(path, "utf8")) as Worklist;
  if (wl.version !== 1 || !Array.isArray(wl.items)) throw new Error(`${path} is not a worklist file`);
  return wl;
}

export function listWorklists(dir: string) {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        const p = join(dir, f);
        try {
          const wl = loadWorklist(p);
          return { file: f, updated: wl.updated, system: wl.system, target_lang: wl.target_lang, ...countByStatus(wl) };
        } catch {
          return { file: f, updated: statSync(p).mtime.toISOString(), invalid: true };
        }
      })
      .sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
  } catch {
    return [];
  }
}

export function countByStatus(wl: Worklist): Record<ItemStatus | "total", number> {
  const c = { total: wl.items.length, missing: 0, translated: 0, proposed: 0, written: 0, error: 0 };
  for (const i of wl.items) c[i.status]++;
  return c;
}

export function buildWorklist(system: string, scope: Scope, targetLang: string, sourceLang: string, texts: SapText[]): Worklist {
  const now = new Date().toISOString();
  return {
    version: 1,
    created: now,
    updated: now,
    system,
    scope,
    target_lang: targetLang,
    source_lang: sourceLang,
    items: texts.map((t, n) => ({
      ...t,
      id: `t${String(n + 1).padStart(5, "0")}`,
      existing: t.target ?? "",
      proposal: "",
      status: t.target ? "translated" : "missing",
      note: "",
    })),
  };
}

/* ---------- Checks for a proposed translation ---------- */

// &1 &2 · symbols &VAR& / SAPscript &VBDKA-VBELN& &PAGE(3)& · {0} · %s · lone &
// SAPscript: character formats <B> </> <H1> and tab ,,
const PLACEHOLDER = /&\d|&[^&\s]{1,80}&|\{\d+\}|%[sd]|<\/?[A-Z0-9]{0,2}>|,,|&(?=\s|$|[.,:;!?)])/g;

function placeholders(s: string): string[] {
  return (s.match(PLACEHOLDER) ?? []).sort();
}

/**
 * True if the SOURCE text is written in capitals only (e.g. "ORDER TYPE").
 * Note: LXE_PCX_S1-UPPCASE is NOT a reliable "upper case only" flag – real data
 * (DDLX labels) has UPPCASE = 'X' with mixed-case texts. So we look at the text itself.
 */
export function isUpperCaseOnly(source: string): boolean {
  const letters = (source ?? "").replace(/[^\p{L}]/gu, "");
  return letters.length >= 2 && letters === letters.toUpperCase() && letters !== letters.toLowerCase();
}

export interface CheckResult {
  ok: boolean; // false = proposal rejected
  text: string; // possibly adjusted text (upper case)
  warnings: string[];
  error?: string;
}

export function checkProposal(item: WorklistItem, proposal: string): CheckResult {
  const warnings: string[] = [];
  let text = proposal.replace(/\r?\n/g, " ");

  if (!text.trim()) return { ok: false, text, warnings, error: "empty translation" };

  if (isUpperCaseOnly(item.source) && text !== text.toUpperCase()) {
    text = text.toUpperCase();
    warnings.push("converted to upper case (source text is all capitals)");
  }

  const len = [...text].length;
  if (item.max_len > 0 && len > item.max_len) {
    return { ok: false, text, warnings, error: `too long: ${len} > max ${item.max_len} characters` };
  }

  const src = placeholders(item.source);
  const tgt = placeholders(text);
  if (src.join("|") !== tgt.join("|")) {
    warnings.push(`placeholders differ: source [${src.join(" ")}] vs translation [${tgt.join(" ")}]`);
  }
  if (/^\s|\s$/.test(text) && !/^\s|\s$/.test(item.source)) warnings.push("leading/trailing spaces");
  if (item.source.trim().endsWith(":") !== text.trim().endsWith(":")) warnings.push("colon at the end differs from source");

  return { ok: true, text, warnings };
}

/* ---------- CSV (semicolon, UTF-8 BOM -> opens directly in German Excel) ---------- */

const CSV_COLUMNS = [
  "id", "status", "object", "obj_name", "objtype", "objname", "textkey", "texttype",
  "max_len", "source_lang", "target_lang", "source", "existing", "proposal", "note",
] as const;

function csvCell(v: unknown): string {
  const s = String(v ?? "");
  return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(wl: Worklist): string {
  const lines = [CSV_COLUMNS.join(";")];
  for (const i of wl.items) lines.push(CSV_COLUMNS.map((c) => csvCell(i[c])).join(";"));
  return "﻿" + lines.join("\r\n") + "\r\n";
}

/** Parse CSV with ; or , delimiter and quoted cells. Returns rows as objects keyed by header. */
export function parseCsv(content: string): Record<string, string>[] {
  const text = content.replace(/^﻿/, "");
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const delim = (firstLine.match(/;/g)?.length ?? 0) >= (firstLine.match(/,/g)?.length ?? 0) ? ";" : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delim) { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  const [header, ...data] = rows.filter((r) => r.some((c) => c !== ""));
  if (!header) return [];
  const keys = header.map((h) => h.trim().toLowerCase());
  return data.map((r) => Object.fromEntries(keys.map((k, n) => [k, r[n] ?? ""])));
}
