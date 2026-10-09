# ABAP backend – setup

Target: S/4HANA 2023 (ABAP Platform 7.58) on-premise. Works on 7.50+ in principle
(uses `/ui2/cl_json`, inline declarations, `REDUCE`).

Tested on ABAP Platform 2025 (SAP ABAP Cloud Developer Trial, release 816).

## 1. Create the objects

Package suggestion: `ZMCP_TRANSLATION` – a **development** package (a structure package
cannot hold classes). Usually the DEV system is enough: translation is done in DEV and
transported.

### Option A – abapGit (recommended)

1. Install [abapGit](https://docs.abapgit.org/user-guide/getting-started/install.html) if needed.
2. abapGit → *New Online* → URL of this repository → package `ZMCP_TRANSLATION` → *Create Online Repo*.
3. *Pull* → choose a transport request → all three classes are created and activated.
   (`.abapgit.xml` points abapGit to `abap/src/`; the Node part is ignored.)

### Option B – manually in ADT

| Object | Type | Source file |
|---|---|---|
| `ZCX_MCP_TRANSL` | Exception class, superclass `CX_STATIC_CHECK` | `src/zcx_mcp_transl.clas.abap` |
| `ZCL_MCP_TRANSL_API` | Class | `src/zcl_mcp_transl_api.clas.abap` |
| `ZCL_MCP_TRANSL_HTTP` | Class | `src/zcl_mcp_transl_http.clas.abap` |

Order: exception → API → HTTP. Paste the full source, activate.

## 2. ICF service (SICF)

1. SICF → `default_host/sap/bc/` → right-click → *New Sub-Element* → `zmcp_transl`
2. Description: "MCP translation service (SE63 API)"
3. Tab *Handler List*: `ZCL_MCP_TRANSL_HTTP`
4. Tab *Logon Data*: procedure **Standard** (no fixed user! Every call must run with the
   real user, so SE63 authorizations and the change log are correct)
5. Save, then right-click → *Activate Service*

Test in the browser is not possible (POST only). Test with curl:

```bash
curl -u MYUSER -X POST -H 'Content-Type: application/json' -d '{}' \
  'https://<host>:<port>/sap/bc/zmcp_transl/ping?sap-client=100'
```

## 3. Authorizations

- `S_TCODE` with `SE63` (checked by the handler)
- the normal translation authorizations of SE63 (`S_TRANSLAT`)
- `S_TRANSPRT` / `S_CTS_ADMI` as for any transport task
- `S_ICF` if your SICF node has an authorization value

## 4. Actions (POST `/sap/bc/zmcp_transl/<action>`, JSON body)

| Action | Input | Output |
|---|---|---|
| `ping` | – | system, client, user, release |
| `list_objects` | `package_name`, `include_subpackages`, `transport`, `objects[]`, `object_types[]` | R3TR objects |
| `status` | as list_objects + `target_lang` or `target_langs[]`, `source_lang?` | status per SE63 object & language (`T` = translated) |
| `read_texts` | as list_objects + `target_lang`, `source_lang?`, `only_missing`, `max_texts` | text pairs (source, target, max_len, texttype, textkey …) |
| `write_texts` | `texts[]` (from read_texts, with `target` filled), `transport`, `dry_run`, `no_transport` | result per text |

`source_lang` empty → the original language of each object is used (like SE63).

Languages can be given as ISO (`DE`), SAP key (`D`) or LXE (`deDE`).

## 5. How the objects map to SE63

`LXE_OBJ_EXPAND_TRANSPORT_OBJ` turns each R3TR object into the SE63 objects behind it.
This is the same logic as SE63 → *Translation → ABAP Objects → Transport Object*.
Examples:

| R3TR | What is translated |
|---|---|
| `DDLS` | CDS view: `@EndUserText.label`, `@EndUserText.quickInfo` of fields/entity |
| `DDLX` | Metadata extension: `@UI...label` texts |
| `DTEL`, `DOMA` | Field labels, domain fixed values |
| `MSAG` | Messages |
| `CLAS`, `PROG`, `FUGR` | Text pool (text symbols, selection texts) |
| `WAPA` | SAPUI5 app in the ABAP repository (i18n texts, see below) |
| `SOTR` / `SOTS` | OTR texts |

### SAPUI5 / Fiori apps

The i18n texts of a UI5 app are only visible in SE63 if:

- the file is `i18n.properties` (or `*.properties`) in the app,
- the first line is `# SAPUI5 TRANSLATION-KEY <32-char GUID>`,
- each text has a classification, e.g. `#XFLD: Label` / `#XBUT,20: Button`.

Without the translation key the texts are **not** in SE63 – then the app has to
ship `i18n_de.properties` etc. itself (Claude can also generate those files, but
that is outside SE63). See help.sap.com → "Translation Guide for SAPUI5 Application Developers".

## 6. Things to check on the first run

These FM signatures are taken from SE63 / SAP Easy Translation and are stable,
but please confirm on your release (SE37):

- `LXE_OBJ_CREATE_TRANSPORT_ENTRY` (parameter `TABKEY` exists?)
- `LXE_PCX_S1-UNITMLT` = maximum length of the text (used for the length check)
- `LXE_PCX_S1-UPPCASE` values (`X`/`1` = upper case only)

If a parameter name differs, the handler returns HTTP 500 with
`CX_SY_DYN_CALL_PARAM_NOT_FOUND` – no dump, just adjust the call.
