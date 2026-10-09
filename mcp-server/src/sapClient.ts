import { Agent, fetch } from "undici";
import { assertSapConfig, clearPasswordCache, resolvePassword, type Config } from "./config.js";

/* ---------- Types mirroring ZCL_MCP_TRANSL_API (JSON, lower-case names) ---------- */

export interface R3trObject {
  pgmid?: string;
  object: string;
  obj_name: string;
  devclass?: string;
}

export interface SapText {
  object: string;
  obj_name: string;
  custmnr: string;
  objtype: string;
  objname: string;
  source_lang: string;
  target_lang: string;
  textkey: string;
  texttype: string;
  max_len: number;
  uppcase: string;
  source: string;
  target: string;
}

export interface Scope {
  package_name?: string;
  include_subpackages?: boolean;
  transport?: string;
  objects?: R3trObject[];
  object_types?: string[];
}

export interface PingResponse {
  system: string;
  client: string;
  user: string;
  release: string;
  logon_lang: string;
  lxe_lang: string;
  server_time: string;
}

export interface ListResponse {
  count: number;
  objects: R3trObject[];
}

export interface StatusResponse {
  count: number;
  status: {
    object: string;
    obj_name: string;
    objtype: string;
    objname: string;
    source_lang: string;
    target_lang: string;
    status: string;
    translated: boolean;
  }[];
  messages: string[];
}

export interface ReadResponse {
  object_count: number;
  text_count: number;
  truncated: boolean;
  texts: SapText[];
  messages: string[];
}

export interface WriteResponse {
  dry_run: boolean;
  written: number;
  errors: number;
  task: string;
  results: { objtype: string; objname: string; textkey: string; result: string; message: string }[];
  messages: string[];
}

/* ---------- Client ---------- */

export class SapClient {
  private readonly dispatcher: Agent;

  constructor(private readonly cfg: Config) {
    this.dispatcher = new Agent({
      connect: { rejectUnauthorized: !cfg.allowSelfSigned },
      headersTimeout: 10 * 60_000,
      bodyTimeout: 10 * 60_000,
    });
  }

  private async call<T>(action: string, body: object = {}): Promise<T> {
    assertSapConfig(this.cfg);
    const qs = new URLSearchParams();
    if (this.cfg.client) qs.set("sap-client", this.cfg.client);
    if (this.cfg.language) qs.set("sap-language", this.cfg.language);
    const url = `${this.cfg.url}${this.cfg.servicePath}/${action}?${qs}`;
    const auth = Buffer.from(`${this.cfg.user}:${await resolvePassword(this.cfg)}`).toString("base64");

    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(body),
        dispatcher: this.dispatcher,
      });
    } catch (e) {
      const cause = (e as { cause?: { code?: string; message?: string } }).cause;
      throw new Error(
        `Cannot reach SAP at ${this.cfg.url}: ${cause?.code ?? ""} ${cause?.message ?? (e as Error).message}`.trim() +
          (cause?.code?.includes("CERT") || cause?.code === "SELF_SIGNED_CERT_IN_CHAIN"
            ? " — set NODE_EXTRA_CA_CERTS to your company CA, or SAP_ALLOW_SELF_SIGNED=true for test systems."
            : ""),
      );
    }

    const text = await res.text();
    if (res.status === 401) clearPasswordCache(); // password may have changed in the keychain
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      const hint =
        res.status === 401
          ? "Logon failed (check SAP_USER / SAP_PASSWORD / SAP_CLIENT)."
          : res.status === 404 || res.status === 403
            ? `Is the SICF service ${this.cfg.servicePath} active?`
            : "";
      throw new Error(`SAP returned HTTP ${res.status} (not JSON). ${hint} ${text.slice(0, 300)}`.trim());
    }
    if (!res.ok) {
      const err = (json as { error?: string }).error ?? text.slice(0, 300);
      throw new Error(`SAP error (HTTP ${res.status}): ${err}`);
    }
    return json as T;
  }

  ping() {
    return this.call<PingResponse>("ping");
  }

  listObjects(scope: Scope) {
    return this.call<ListResponse>("list_objects", scope);
  }

  status(scope: Scope, targetLangs: string[], sourceLang?: string) {
    return this.call<StatusResponse>("status", { ...scope, target_langs: targetLangs, source_lang: sourceLang ?? "" });
  }

  readTexts(scope: Scope, targetLang: string, opts: { sourceLang?: string; onlyMissing?: boolean; maxTexts?: number } = {}) {
    return this.call<ReadResponse>("read_texts", {
      ...scope,
      target_lang: targetLang,
      source_lang: opts.sourceLang ?? "",
      only_missing: opts.onlyMissing ?? false,
      max_texts: opts.maxTexts ?? 0,
    });
  }

  writeTexts(texts: SapText[], opts: { transport?: string; dryRun: boolean; noTransport?: boolean }) {
    return this.call<WriteResponse>("write_texts", {
      texts,
      transport: opts.transport ?? "",
      dry_run: opts.dryRun,
      no_transport: opts.noTransport ?? false,
    });
  }
}
