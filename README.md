# SAP SE63 Translation MCP Server

Translate SAP development objects – CDS views, metadata extensions, Fiori/UI5 apps,
data elements, messages, text pools, service definitions, SE71 forms, SO10 texts … – **with Claude**, through
the same API that transaction **SE63** uses.

```
Claude ──MCP (stdio)──► mcp-server (Node)  ──HTTPS/JSON──►  /sap/bc/zmcp_transl
                              │                              ZCL_MCP_TRANSL_HTTP
                              ▼                              ZCL_MCP_TRANSL_API ──► LXE_* (SE63 API)
                    worklists/*.json + *.csv (Excel)          ZCL_MCP_TRANSL_SAPSCRIPT ──► SE71 / SO10
```

SE63 is a SAP GUI transaction, but internally it only calls the `LXE_*` function
modules (`LXE_OBJ_TEXT_PAIR_READ/WRITE`, …). Small ABAP classes expose exactly
these calls as JSON. SAPscript long texts (SE71 forms, SO10 standard texts) are not
text pairs – a fourth class reads/writes them with `READ_FORM`/`SAVE_FORM` and
`READ_TEXT`/`SAVE_TEXT`, one paragraph per worklist item. Claude does the translating itself – no DeepL or other API key.
Every call runs with **your** SAP user, so authorizations, change log and transport
work as in SE63.

## Quick install – let Claude do it

In **Claude Code** (or Claude with access to your computer) say:

> Install the SAP SE63 translation MCP server from https://github.com/AlexRyzhikov/sap-se63-translation-mcp

Claude follows [`CLAUDE.md`](CLAUDE.md): clone → `npm ci` → build → test → setup.
It asks you for URL, client and user. **The password you type only into your own
terminal / the macOS keychain dialog – never into the chat.**

## Manual install

Requirements: Node.js ≥ 20, git, an SAP system (S/4HANA / ABAP Platform ≥ 7.50).

```bash
git clone https://github.com/AlexRyzhikov/sap-se63-translation-mcp.git
cd sap-se63-translation-mcp/mcp-server
npm ci
npm run build
npm test            # optional, runs against a mock SAP
npm run setup       # asks connection data, stores password, tests, registers in Claude Desktop
```

`npm run setup` does four things:

| Step | What | Where |
|---|---|---|
| 1 | URL, client, user, language, certificates | `mcp-server/.env` (no password) |
| 2 | password | macOS keychain (hidden input). Other OS: `SAP_PASSWORD_CMD` |
| 3 | connection test (`ping`) | – |
| 4 | register the server | `claude_desktop_config.json` (merged, backup `.bak`) |

Non-interactive (scripts, Claude):
`npm run setup -- --yes --url https://host:44300 --client 100 --user MYUSER`
(`--self-signed` for local systems, `--no-claude` to skip step 4, `--help` for all options).

Then quit Claude Desktop completely and start it again → *"Ping SAP"*.

Claude Code instead of Desktop: `claude mcp add sap-se63-translation -- node /path/to/mcp-server/dist/index.js`

### SAP side (once per system) – choose one way

**A) Transport files (easiest, no abapGit):** download [`transport/`](transport) –
`K900167.A4H` → `/usr/sap/trans/cofiles`, `R900167.A4H` → `/usr/sap/trans/data` →
STMS: add request `A4HK900167` to the import queue → import (*Ignore Invalid Component Version*,
*Overwrite Originals*) → **activate** the service `/sap/bc/zmcp_transl` in SICF.
Contains the package `ZMCP_TRANSLATION`, all 4 classes and the ICF service.
Step by step: [`transport/README.md`](transport/README.md).

**B) abapGit (if you want to change the code):**

1. **ABAP classes** – with [abapGit](https://abapgit.org): *New Online* → this repo →
   package of your choice (e.g. `ZMCP_TRANSLATION`) → *Pull*. Or create the four
   classes from [`abap/src`](abap/src) manually in ADT (activate SAPscript + API together).
2. **SICF service** `/sap/bc/zmcp_transl` with handler `ZCL_MCP_TRANSL_HTTP` –
   2 minutes, see [`abap/SETUP.md`](abap/SETUP.md).

## Workflow

1. `sap_translation_status` – what is missing?
2. `sap_download_translations` – text pairs → local worklist (JSON + CSV for Excel)
3. Claude translates → `worklist_set_translations` (checks max length, placeholders `&1 {0} %s`)
4. optional review in Excel → `worklist_import_csv`
5. `sap_upload_translations` – dry run first, then write + transport entry

Or just say: *"Translate package ZMY_PACKAGE into German, transport DEVK900123."*

### What can be translated

| Object | How | Example |
|---|---|---|
| CDS `DDLS`, `DDLX`, `SRVD`, DDIC `DTEL` `DOMA` `TABL`, `MSAG`, text pools `CLAS` `PROG` `FUGR`, OTR, UI5 `WAPA` | SE63 text pairs (LXE) | *"Translate package ZRR01 to DE"* |
| SE71 SAPscript form `FORM` | paragraphs, own logic | *"Translate SE71 form ZMY_FORM to RU"* |
| SO10 standard text `TEXT` | paragraphs, own logic | *"Translate SO10 text TEST_123 ST from EN to RU"* |
| Adobe form `SFPF` | only form/interface texts (`TLGS`) | – |

## Tools

| Tool | Purpose |
|---|---|
| `sap_ping` | test connection |
| `sap_list_objects` | objects of a package (+ sub-packages) / transport |
| `sap_translation_status` | translated yes/no per object & language |
| `sap_download_translations` | text pairs → worklist file |
| `worklist_list` / `worklist_get` | list worklists / read texts (filter, paging) |
| `worklist_set_translations` | store proposals (with checks) |
| `worklist_import_csv` | import reviewed CSV |
| `sap_upload_translations` | write to SAP + transport (dry run first) |

Languages: ISO (`DE`), SAP key (`D`) or LXE (`deDE`).

## Security

- No password in any file. macOS keychain, or `SAP_PASSWORD_CMD` (1Password CLI, `secret-tool`, …).
- The ICF handler checks `S_TCODE` = `SE63`; SE63's own authorizations apply.
- `SAP_ALLOW_SELF_SIGNED=true` only for local/test systems. Better: `NODE_EXTRA_CA_CERTS=/path/ca.pem`.

## Notes / limits

- **Original language matters.** SE63 translates *from* the object's original language.
  Objects created with logon language EN but German texts will show German as "English".
- **Installed languages:** a translation is visible only if the language is in
  `zcsa/installed_languages` (RZ11) and classified in SMLT.
- **UI5 apps:** i18n texts appear in SE63 only with the `# SAPUI5 TRANSLATION-KEY` header.
- **Status:** texts are written; the SE63 object status may show `M` instead of `T`.
- **Generated objects** (table maintenance function groups) are best left alone.
- **SAPscript:** SE71 forms (`FORM`) and SO10 texts (`TEXT`) are translated paragraph by paragraph
  (own logic, see [`abap/SETUP.md`](abap/SETUP.md)). Form descriptions are not translated.
- **Adobe forms (SFP):** only the form/interface texts; layout texts (`PDFB`) are not supported yet.
- **Long texts** (SE61 documentation) are not covered.

## License

MIT
