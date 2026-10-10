# ABAP backend – setup

Target: S/4HANA 2023 (ABAP Platform 7.58) on-premise. Works on 7.50+ in principle
(uses `/ui2/cl_json`, inline declarations, `REDUCE`).

Tested on ABAP Platform 2025 (SAP ABAP Cloud Developer Trial, release 816).

## Objects of the solution

One transport request with these objects is everything the SAP side needs:

| Object | Name | In this repo |
|---|---|---|
| `R3TR DEVC` | development package (e.g. `ZMCP_TRANSLATION`) | `src/package.devc.xml` |
| `R3TR CLAS` | `ZCX_MCP_TRANSL` – exception | `src/zcx_mcp_transl.clas.*` |
| `R3TR CLAS` | `ZCL_MCP_TRANSL_SAPSCRIPT` – SE71 / SO10 | `src/zcl_mcp_transl_sapscript.clas.*` |
| `R3TR CLAS` | `ZCL_MCP_TRANSL_API` – SE63 / LXE + routing | `src/zcl_mcp_transl_api.clas.*` |
| `R3TR CLAS` | `ZCL_MCP_TRANSL_HTTP` – ICF handler | `src/zcl_mcp_transl_http.clas.*` |
| `R3TR SICF` | `/sap/bc/zmcp_transl` | not in abapGit – create it by hand (step 2) |

The class sources in `src/` are the active versions from the reference system (release 816);
SAP returns them with CRLF line endings, the repo stores LF – the content is the same.

## 1. Create the objects

Package suggestion: `ZMCP_TRANSLATION` – a **development** package (a structure package
cannot hold classes). Usually the DEV system is enough: translation is done in DEV and
transported.

### Option A – abapGit (recommended)

1. Install [abapGit](https://docs.abapgit.org/user-guide/getting-started/install.html) if needed.
2. abapGit → *New Online* → URL of this repository → package `ZMCP_TRANSLATION` → *Create Online Repo*.
3. *Pull* → choose a transport request → all four classes are created and activated.
   (`.abapgit.xml` points abapGit to `abap/src/`; the Node part is ignored.)

### Option B – manually in ADT

| Object | Type | Source file |
|---|---|---|
| `ZCX_MCP_TRANSL` | Exception class, superclass `CX_STATIC_CHECK` | `src/zcx_mcp_transl.clas.abap` |
| `ZCL_MCP_TRANSL_SAPSCRIPT` | Class | `src/zcl_mcp_transl_sapscript.clas.abap` |
| `ZCL_MCP_TRANSL_API` | Class | `src/zcl_mcp_transl_api.clas.abap` |
| `ZCL_MCP_TRANSL_HTTP` | Class | `src/zcl_mcp_transl_http.clas.abap` |

Order: exception → SAPscript → API → HTTP. Paste the full source, then activate
SAPscript + API **together** (they use each other's types).
Via ADT REST: `POST /sap/bc/adt/oo/classes` (create), LOCK → `PUT …/source/main` → UNLOCK,
then one `POST /sap/bc/adt/activation` with both object references.

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
| `SFPF` | Adobe form (SFP): form description and interface texts (`TLGS`). **Layout texts (`PDFB`) are not supported yet** |
| `FORM` | SE71 SAPscript form – own logic, see below |
| `TEXT` | SO10 standard text – own logic, see below |

### SAPscript: SE71 forms and SO10 standard texts

These are long texts, not text pairs, so `LXE_OBJ_EXPAND_TRANSPORT_OBJ` returns nothing for them.
`ZCL_MCP_TRANSL_SAPSCRIPT` handles them directly:

- read with `READ_FORM` / `READ_TEXT`, write with `SAVE_FORM` / `SAVE_TEXT`
- the lines are split into paragraphs (one paragraph = one text, `textkey` = `<window>/<no>`,
  `texttype` = paragraph format). Command lines `/:`, comments `/*`, windows `/W`, text elements `/E`
  and paragraphs without words (only `&symbols&`) are kept unchanged.
- after translation the paragraph is wrapped again to 132 characters (blank → format ` `,
  hard cut → format `=`; symbols `&…&` are never split)
- paragraphs without a proposal keep the existing translation, otherwise the source text
- if the existing translation has other paragraphs than the source, it is replaced
- SO10 name: `ZMY_TEXT` or `ZMY_TEXT,ST` (text ID, default `ST`); only text object `TEXT`.
  Standard texts are not in a package – give them as `objects` or via a transport (`R3TR TEXT TEXT,<name>,<id>,<lang>`).
- transport entries: `R3TR TEXT TEXT,<name>,<id>,<lang>` and `LANG FORM <form>` (language = target)
- forms are client-dependent: SAP standard forms are often only in client 000
- form descriptions (window/paragraph names) are not translated
- the source text is taken as it is stored: if lines were cut when the text was pasted into SO10,
  the paragraph contains the cut words too – check the source before translating

Example (SO10 text `TEST_123`, ID `ST`, EN → RU):

```
sap_download_translations  objects=[{object:"TEXT", obj_name:"TEST_123,ST"}]  source_lang=EN target_lang=RU
→ worklist item  textkey 0001, texttype *, max_len 0 (one paragraph)
sap_upload_translations    dry_run=true → then dry_run=false with a transport (R3TR TEXT TEXT,TEST_123,ST,R)
```

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

SAPscript – verified on release 816 (function groups STXS / STXD):

- `READ_FORM` (`FORM`, `LANGUAGE`, `FOUND`, `FORM_HEADER` + tables `FORM_LINES PAGES PAGE_WINDOWS
  PARAGRAPHS STRINGS TABS WINDOWS`) and `SAVE_FORM` (`FORM_HEADER` + same tables) match the code.
- `SAVE_FORM` takes the status from `FORM_HEADER-TDSTATUS`; the header of the active version is
  passed on, so the translated form stays active. Still worth a look in SE71 after the first upload.
- Still to confirm on the first form upload: `LANG FORM <form>` is accepted in the transport
  (otherwise add `R3TR FORM <form>` manually).

If a parameter name differs, the handler returns HTTP 500 with
`CX_SY_DYN_CALL_PARAM_NOT_FOUND` – no dump, just adjust the call.
