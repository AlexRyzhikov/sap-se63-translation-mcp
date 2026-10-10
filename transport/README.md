# SAP transport files

Import the SAP side (4 classes + ICF service) with a normal transport – no abapGit needed.

| File | Copy to |
|---|---|
| `K900167.A4H` (cofile) | `/usr/sap/trans/cofiles/` |
| `R900167.A4H` (data file) | `/usr/sap/trans/data/` |

Request **A4HK900167**, package **`ZMCP_TRANSLATION`**:

| Object | |
|---|---|
| `R3TR DEVC ZMCP_TRANSLATION` | package (no super package, software component HOME) |
| `R3TR CLAS ZCX_MCP_TRANSL` | exception |
| `R3TR CLAS ZCL_MCP_TRANSL_SAPSCRIPT` | SE71 / SO10 texts |
| `R3TR CLAS ZCL_MCP_TRANSL_API` | SE63 / LXE API |
| `R3TR CLAS ZCL_MCP_TRANSL_HTTP` | ICF handler |
| `R3TR SICF ZMCP_TRANSL` | service `/sap/bc/zmcp_transl` |

Exported from ABAP Platform release 816 (SAP ABAP Cloud Developer Trial).

## Import

1. **Copy the files** to the transport directory of the target system (`DIR_TRANS`, usually `/usr/sap/trans`).
   They must belong to `<sid>adm`:
   ```bash
   cp K900167.A4H /usr/sap/trans/cofiles/
   cp R900167.A4H /usr/sap/trans/data/
   chown <sid>adm:sapsys /usr/sap/trans/cofiles/K900167.A4H /usr/sap/trans/data/R900167.A4H
   chmod 664 /usr/sap/trans/cofiles/K900167.A4H /usr/sap/trans/data/R900167.A4H
   ```
   Docker trial system: `docker cp K900167.A4H <container>:/usr/sap/trans/cofiles/` (same for the data file).
2. **Add to the import queue:** STMS → *Import Overview* → your system → *Extras → Other Requests → Add* →
   `A4HK900167` → confirm.
   (Command line: `tp addtobuffer A4HK900167 <SID> client=<client> pf=/usr/sap/trans/bin/TP_DOMAIN_<DC>.PFL`)
3. **Import:** select the request → *Import Request* → target client → tab *Options*:
   - ☑ *Ignore Invalid Component Version* (the request comes from another system / release)
   - ☑ *Overwrite Originals*
4. **Activate the ICF service** – imported ICF services are inactive for security reasons:
   SICF → `default_host/sap/bc/zmcp_transl` → right-click → *Activate Service*.
   Check tab *Logon Data*: procedure **Standard**, no fixed user.
5. **Authorizations:** `S_TCODE` = `SE63` and the normal SE63 / transport authorizations (see `../abap/SETUP.md`).
6. **Test:** `npm run setup` in `mcp-server` (step 3 = ping), or in Claude: *"Ping SAP"*.

## Good to know

- **Return code 4** is normal: the package keeps its transport layer `ZDEV`. If the layer does not exist
  in your landscape, change it afterwards (SE21 / package properties).
- **Original system is A4H.** To change the classes in your system, either accept the repair dialog or
  set your system as original system (SE03 → *Change Original System*).
- **Older releases:** the classes use ABAP 7.50+ syntax. A transport from release 816 into a much older
  release is not guaranteed by SAP – if the import fails there, use **abapGit** with `../abap/src` instead.
- abapGit (`../abap/src`) is also the better way if you want to develop the classes further.
