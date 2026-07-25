# IDML Adobe validation and native-release gate

Status: required for AQU-709. The default `VITE_IDML_FIDELITY_STAGE` is
`experimental`. A build cannot claim `native` fidelity without a digest-pinned,
zero-loss report produced by InDesign Server.

Adobe documents UXP scripting for InDesign 18.0+ and InDesign Server, including
`script.args`/`script.setResult`, `Document.exportFile`, and synchronous
`PreflightProcess.waitForProcess`:

- <https://developer.adobe.com/indesign/uxp/scripts/>
- <https://developer.adobe.com/indesign/uxp/scripts/tutorials/arguments/>
- <https://developer.adobe.com/indesign/uxp/dom/api/d/document/>
- <https://developer.adobe.com/indesign/uxp/dom/api/p/preflight-process/>

## Evidence contract

Create a manifest whose source and candidate paths are relative to the manifest
file. `candidate` is the IDML exported by Aquilla or Codex; `source` is the
original artifact used to produce it.

```json
{
  "schemaVersion": 1,
  "engineVersion": 2,
  "sourceCommit": "FULL_GIT_SHA",
  "preflightProfile": "Aquilla IDML Production",
  "gates": {
    "browser": "passed",
    "migration": "passed"
  },
  "fixtures": [
    {
      "id": "mixed-character-runs",
      "source": "./source/mixed-character-runs.idml",
      "candidate": "./exports/mixed-character-runs.idml",
      "allowReflow": true,
      "exportReport": {
        "translated": 3,
        "missing": 0,
        "rejected": 0,
        "unsupported": 0
      }
    }
  ]
}
```

Every fixture must have a unique stable ID. Do not omit a fixture because it
fails. `unsupported` is an error for the native gate; unknown constructs may be
preserved and diagnosed during experimental use, but native evidence cannot
contain a silent skip.

The Adobe-side script records no story text or translated text. It records:

- page, spread, master, layer, story, table, link, hyperlink, footnote, and note
  counts;
- page-item IDs, types, geometry, object styles, layers, and parent pages;
- table dimensions and style assignments;
- paragraph and character style assignments;
- overset story IDs;
- typed errors, preflight results, produced IDML/PDF sizes, Adobe version, and
  duration.

Product analytics use a narrower allowlist: v2 profile/construct counts, typed
failure codes, mapping failures, size delta, and duration. Member paths,
locators, file names, source HTML, translated HTML, and text are never sent.

## Automated InDesign Server gate

Prerequisites:

1. InDesign Server 18.5 or later and its `sampleclient`.
2. An installed preflight profile named exactly as the manifest specifies.
3. Original and exported fixture corpora on a filesystem visible to the server.
4. Browser and migration producer/consumer suites already green.

Run:

```sh
pnpm idml:adobe run-server \
  --manifest artifacts/idml/adobe-manifest.json \
  --output-dir artifacts/idml/adobe-results \
  --sample-client "/path/to/sampleclient" \
  --host localhost:12345
```

For every candidate, the UXP script:

1. disables interactive dialogs so a repair/format prompt becomes a failure;
2. opens and recomposes the original and candidate;
3. runs the named preflight profile and captures its completed result;
4. exports the candidate to a fresh IDML;
5. closes and reopens that Adobe-produced IDML;
6. reruns preflight and structural inventory;
7. exports a non-empty PDF;
8. closes every document without modifying the source/candidate inputs.

The Node finalizer independently compares source/candidate and
candidate/save-reopen structure. Translation-driven overset changes are
warnings, not structural failures. Missing objects, geometry changes, style
assignment changes, lost tables/links/footnotes, preflight failures, repair
errors, mapping failures, and empty outputs fail the report.

Keep these artifacts together:

- `adobe-materialized-manifest.json`
- `adobe-raw-report.json`
- `adobe-gate-report.json`
- `*.adobe-resaved.idml`
- `*.pdf`
- InDesign Server/sampleclient logs
- the SHA-256 printed by the finalizer

## Manual desktop fallback

The fallback produces the same structural evidence, but it is marked
`desktop-manual` and **cannot enable native fidelity**.

1. Confirm InDesign 18.5+ is installed and the named production preflight
   profile is active and unchanged.
2. Close all documents. Record the InDesign version, OS, fonts, linked assets,
   profile checksum, repository commit, and operator.
3. Prepare a wrapper:

   ```sh
   pnpm idml:adobe prepare-desktop \
     --manifest artifacts/idml/adobe-manifest.json \
     --output-dir artifacts/idml/adobe-results
   ```

4. Put the printed `run-adobe-validation.idjs` in the InDesign Scripts Panel
   folder (or reveal that folder from Window → Utilities → Scripts), then run it
   once. Do not click through a repair, conversion, missing-link, or overwrite
   dialog; capture it and mark the fixture failed.
5. Finalize:

   ```sh
   pnpm idml:adobe finalize \
     --manifest artifacts/idml/adobe-manifest.json \
     --output-dir artifacts/idml/adobe-results
   ```

6. Visually inspect every produced PDF against the original for page/spread,
   master, layer, asset, table, footnote, hyperlink, and frame placement.
   Record expected reflow/overset separately from corruption.
7. Attach the report, PDFs, saved IDML files, screenshots, and checklist to
   AQU-709.

Manual evidence may support an internal/beta decision. The build gate rejects
it for `native`.

## Release stages

- `experimental` (default): protected content-only IDML; no native claim.
- `internal`: explicit `VITE_IDML_INTERNAL_ORGS` allowlist.
- `beta`: explicit `VITE_IDML_BETA_ORGS` allowlist, browser/migration gates, and
  digest-pinned Adobe evidence.
- `native`: automated InDesign Server report only, all fixtures passed, and zero
  silent skips, anchor loss, or mapping failures.

For beta/native builds:

```sh
export VITE_IDML_FIDELITY_STAGE=beta
export IDML_BROWSER_GATE_PASSED=1
export IDML_MIGRATION_GATE_PASSED=1
export IDML_ADOBE_GATE_REPORT=/absolute/path/adobe-gate-report.json
export VITE_IDML_ADOBE_REPORT_SHA256=PRINTED_REPORT_SHA256
export IDML_SOURCE_COMMIT=THE_SAME_FULL_GIT_SHA_AS_THE_REPORT
npm run build
```

Changing the stage or report without valid evidence fails before TypeScript or
Vite runs. Beta/native evidence is bound to the exact 40-character source commit
(`GITHUB_SHA` and `CF_PAGES_COMMIT_SHA` are accepted provider fallbacks). Do not
bypass `pnpm idml:gate`.
