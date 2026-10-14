import { Agent, fetch } from "undici";
import { assertSapConfig, clearPasswordCache, passwordStoreHint, resolvePassword, type Config } from "./config.js";

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

/* ---------- Error helpers ---------- */

/**
 * SAP does not always answer a rejected logon with 401. When the ICF service falls back to
 * form-based logon – the usual case for an expired password – it answers HTTP **200** with
 * its HTML logon page, which used to surface as the unhelpful "HTTP 200 (not JSON)".
 * Matches the SAP system-login form itself, not only the English page title.
 */
function isSapLogonPage(body: string): boolean {
  const head = body.slice(0, 4000);
  if (!/<html/i.test(head)) return false;
  return (
    /sap-system-login/i.test(head) ||
    (/sap-user/i.test(head) && /sap-password/i.test(head)) ||
    /<title>[^<]*logon[^<]*sap[^<]*<\/title>/i.test(head)
  );
}

/**
 * Node ships its own CA list and does not read the OS certificate store, so a company CA
 * that works in the browser still fails here. Order the fixes by preference and keep the
 * "switch checking off" option last – a company CA is not a self-signed certificate.
 */
function certHint(): string {
  return (
    " — Node has its own CA list and does not read the OS certificate store, so a company CA that works in your browser still fails here. Fixes, best first: " +
    "(1) NODE_OPTIONS=--use-system-ca (Node >= 22.15) trusts whatever the OS trusts; " +
    "(2) NODE_EXTRA_CA_CERTS=<path>/company-ca.pem – this has to be a PEM *file*, a directory is ignored with an I/O warning; " +
    "(3) SAP_ALLOW_SELF_SIGNED=true for local/test systems only – it turns certificate checking off."
  );
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
          (cause?.code?.includes("CERT") || cause?.code === "SELF_SIGNED_CERT_IN_CHAIN" ? certHint() : ""),
      );
    }

    const text = await res.text();
    // A rejected logon is not always a 401: with the SAP logon page it is a 200.
    // Both mean the stored password was not accepted, so drop it from the cache –
    // otherwise a long-running server keeps retrying a password the user already fixed.
    if (res.status === 401 || isSapLogonPage(text)) clearPasswordCache();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      if (isSapLogonPage(text)) {
        throw new Error(
          `SAP answered with its HTML logon page instead of JSON (HTTP ${res.status}) – the logon was rejected. ` +
            `Most likely: the password of ${this.cfg.user || "<SAP_USER>"} has expired or must be changed ` +
            `(check SU01 → Logon Data, and log on once in SAP GUI), the user is locked, ` +
            `or the SICF service ${this.cfg.servicePath} does not allow basic authentication ` +
            `(SICF → Logon Data → put "Basic Authentication" first, then re-activate the service). ` +
            passwordStoreHint(this.cfg),
        );
      }
      const hint =
        res.status === 401
          ? "Logon failed (check SAP_USER / SAP_CLIENT and the stored password)."
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
