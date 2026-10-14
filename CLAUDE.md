# Instructions for Claude

This repo is an MCP server that translates SAP objects via the SE63 / LXE API.
When the user asks you to **install** it, follow these steps exactly.

## Install

1. **Check prerequisites:** `node -v` (must be **≥ 22.15**) and `git --version`.
   If Node is missing or older, tell the user how to install it and stop:
   `winget install OpenJS.NodeJS.LTS` (Windows), `brew install node` (macOS).
   Node 20 is end-of-life, and `--use-system-ca` (step 7) only exists from 22.15 on.
2. **Get the code** (skip if you are already inside the clone):
   ```bash
   git clone https://github.com/AlexRyzhikov/sap-se63-translation-mcp.git ~/sap-se63-translation-mcp
   cd ~/sap-se63-translation-mcp/mcp-server
   ```
3. **Install and build** – never with `sudo`:
   ```bash
   npm ci && npm run build && npm test
   ```
   `npm test` must end with `ALL TESTS PASSED` and `SETUP TEST PASSED`.
   EACCES errors mean root-owned files from an earlier `sudo npm`:
   suggest `sudo chown -R $(whoami) ~/.npm <repo-folder>` and retry.
4. **Ask the user** (one question each, plain chat):
   - SAP URL incl. HTTPS port (SMICM → Services), e.g. `https://myhost:44300`
   - client (e.g. `100`)
   - SAP user
   - self-signed certificate? (yes only for local/trial systems such as `https://localhost:50001`)
5. **Run setup non-interactively:**
   ```bash
   npm run setup -- --yes --url <URL> --client <CLIENT> --user <USER> [--self-signed]
   ```
   **On Windows always call `node dist/setup.js --yes --url … --client … --user …` instead** –
   `npm.ps1` swallows the `--`, so every flag is lost and setup prompts interactively.
6. **Password – the user does this, not you.**
   - **Never** ask for the password in the chat, never put it in a file, env var or command line.
   - macOS: ask the user to run in **their own terminal** (input is hidden):
     `security add-generic-password -U -s sap-se63-mcp -a <USER> -w`
   - Windows: setup already set `SAP_PASSWORD_CMD` to `scripts/windows-password.ps1` (DPAPI).
     Ask the user to run, in their own terminal:
     `pwsh -NoProfile -File <repo>\mcp-server\scripts\windows-password.ps1 -Store -User <USER>`
     No `pwsh`? `winget install Microsoft.PowerShell` – Windows PowerShell 5.1 cannot read a
     `SecureString` back under AppLocker (Constrained Language Mode) and fails silently.
   - Linux: explain `SAP_PASSWORD_CMD` in `mcp-server/.env` (1Password CLI, `secret-tool`).
7. **Test:** after the user confirms, run `npm run setup -- --yes --no-claude` again
   (Windows: `node dist/setup.js --yes --no-claude`). Step 3/4 must show `connected: system …`.
   Typical errors:
   - **HTML logon page (HTTP 200)** → the logon was rejected. Password expired or must be changed
     (SU01 → *Logon Data*; have the user log on once in SAP GUI), user locked, or the SICF service
     does not allow basic authentication. After the user stores a new password, Claude Desktop must
     be restarted only if the server was already running with the old one.
   - **401** → user / password / client.
   - **403/404** → SICF service not active or classes missing (see `abap/SETUP.md`).
   - **Certificate error** → `NODE_OPTIONS=--use-system-ca` first (Node ≥ 22.15, uses the OS store
     the browser already trusts), else `NODE_EXTRA_CA_CERTS=<file>.pem`. `--self-signed` only for
     local/test systems. Never suggest switching certificate checks off for a company CA.
8. **Finish:** tell the user to quit Claude Desktop completely and restart it, then say *"Ping SAP"*.
   On Windows "completely" means via the tray icon – closing the window leaves the server running
   with the old config. If Claude still does not see the server, check *Settings → Developer →
   Edit Config*: a Microsoft Store (MSIX) install reads
   `%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude\`, not `%APPDATA%\Claude\`. Add the
   entry to the file that button opens, and **merge** it – that file holds the app's own settings.
   For Claude Code: `claude mcp add sap-se63-translation -- "$(which node)" "$PWD/dist/index.js"`.

The **SAP side** (4 ABAP classes + 1 SICF node) is described in `abap/SETUP.md`. Easiest for the user:
import the transport files in `transport/` (see `transport/README.md`), then activate the SICF service.
Ask the user whether it is already installed before debugging connection errors.

## Using the tools (translation work)

- Always: `sap_translation_status` / `sap_download_translations` → translate → `worklist_set_translations`
  → `sap_upload_translations` with `dry_run=true` → user OK → `dry_run=false`.
- Ask for the transport request before writing. Never write without the user's OK.
- Respect `max_len`; keep placeholders (`&1 & {0} %s`); keep device/product names unchanged.
- Skip generated objects (table maintenance function groups) and technical names (entity set names, `+`).
- Use SAP standard terminology of the target language (e.g. DE Werk/Charge, RU Завод/Партия).
- SE71 form = object `FORM`, SO10 text = object `TEXT` (name `ZTEXT` or `ZTEXT,ST`). One item = one paragraph,
  `max_len` 0. Keep `&SYMBOLS&`, `<B>…</>` and `,,` exactly. SAP standard forms are often only in client 000.
  SO10 texts have no package: always ask whether to write with a transport (`R3TR TEXT`) or without.
  If the source paragraph looks cut (words glued together), tell the user before writing.
- Adobe forms (`SFPF`): only form/interface texts (`TLGS`); layout texts (`PDFB`) are not supported.

## Development

- `mcp-server/src/index.ts` – MCP tools; `sapClient.ts` – HTTP client; `worklist.ts` – files + checks;
  `setup.ts` – setup wizard; `config.ts` – .env + password lookup.
- `abap/src` – abapGit format. `zcl_mcp_transl_api` = LXE/SE63 + routing, `zcl_mcp_transl_sapscript` =
  SE71/SO10 (split into paragraphs → wrap to 132 chars). Activate both together. Keep `npm test` green.
