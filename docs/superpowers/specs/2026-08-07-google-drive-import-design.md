# Google Drive import — design

**Date:** 2026-08-07
**Status:** Approved design, pending implementation plan

## Summary

Let users import documents into an Aquilla project directly from Google Drive: pick
multiple files or a folder in the Google Picker, download/export the bytes in the
browser, and feed them through the existing import pipeline unchanged. One-time
import in v1, with provenance recorded so a linked-sync mode can be added later
without re-import.

## Decisions (settled during brainstorm)

1. **Import model:** one-time pick & import now; record Drive provenance per file so
   linked sync (DCS-style) can come later.
2. **Auth:** client-only. Google Identity Services (GIS) token client + Google
   Picker, scope `https://www.googleapis.com/auth/drive.file` only. Token lives in
   memory for the session; nothing persisted, no server or DB changes. `drive.file`
   grants access only to items the user explicitly picks, which avoids Google's
   restricted-scope verification.
3. **File scope (v1):**
   - Native Google Docs → exported as DOCX (`files/{id}/export`) → existing DOCX parser.
   - Regular files stored in Drive (.docx, .usfm, .txt, .md, .csv, subtitles,
     audio, …) → downloaded as-is (`files/{id}?alt=media`); existing format
     sniffing handles them.
   - Google Sheets / Slides / Forms and other native types: **not supported in v1**
     — listed loudly as skipped with a "download as .xlsx/.pptx and upload" message.
4. **Selection:** multi-select AND folder selection, with loud warn/drop of
   anything unsupported (see below).

## UX flow

1. New "Google Drive" entry in the import-source menu in
   `src/components/ImportDialog.tsx` (the sources array ~line 841, alongside
   upload / eBible / Door43 / …).
2. Clicking it lazily loads the GIS + Picker scripts, runs the sign-in popup, and
   opens the Picker (multi-select enabled, folder selection enabled).
3. Folder picks are expanded recursively via `files.list` (`'<folderId>' in
   parents`). Total file count capped at 500 — exceeding the cap is a loud error,
   never a silent truncation.
4. **Pre-import summary panel** (no silent drops anywhere):
   - **Will import:** supported files with detected type.
   - **Skipped (N):** every dropped file with its reason — e.g. "unsupported file
     type (.pdf)", "Google Sheets — export as .xlsx and upload", "Google Doc over
     10 MB export limit — download as .docx and upload".
   - User confirms from this panel; the skipped list remains visible in the result.
5. Each accepted file's bytes become `new File([bytes], name)` and flow into
   `prepareImportFile` / `importFile` (`src/lib/import.ts`) exactly like
   drag-and-drop — format sniffing, preview, collision handling, multi-book USFM
   splitting, and R2 artifact upload all work unchanged.

## Code shape

- **New module `src/lib/import/google-drive.ts`** (~200 lines): script loading,
  token acquisition, Picker launch, folder expansion, mimeType →
  export/download/unsupported routing, byte fetching. Pure logic (routing,
  provenance mapping, folder-listing pagination) kept separate from the
  DOM/popup layer so it is unit-testable.
- **`ImportDialog.tsx`:** menu entry + thin panel invoking the module, plus the
  pre-import summary UI.
- **Config:** build-time `VITE_GOOGLE_CLIENT_ID` and `VITE_GOOGLE_API_KEY`
  (Picker requires both).
- **No worker changes, no DB changes.**

## Provenance (linked-later hook)

Each imported file records `{ provider: 'google-drive', driveFileId, revisionId,
mimeType }` via the existing `ImportSourceLocator` mechanism in
`shared/import-contract.ts`. A future linked-sync feature uses this to locate the
upstream doc; re-auth at relink time replaces any need for stored tokens.

## Errors & limits

- Google Docs export cap is 10 MB (Drive API limit) → skipped loudly with manual
  workaround message.
- Existing 95 MB `MAX_SOURCE_ARTIFACT_BYTES` gate still applies after download.
- Token expiry (1 h) is a non-issue for one-time import; a mid-batch 401 aborts
  remaining downloads with a visible error and a re-auth retry option.
- Per-file download/parse failures surface in the existing per-file import error
  UI; one bad file never fails the batch.

## Known risk (verify first in implementation)

Whether `drive.file` + Picker grants access to a picked **folder's children** has
historically been inconsistent. Verify early with a spike. If children are
inaccessible: keep folder selection out of v1 and ship multi-select only, telling
users to select files directly. Do **not** escalate to `drive.readonly` (restricted
scope, requires Google verification).

## Testing

- Unit tests (vitest, mocked `fetch`): mimeType routing (export / download /
  unsupported + reason strings), folder expansion with pagination and the 500-file
  cap, provenance mapping, oversize-export skip.
- The GIS/Picker popup layer cannot run in CI; it stays thin and is covered by a
  manual QA pass. No Playwright spec (external OAuth cannot run in the harness).

## Out of scope (v1)

- Linked sync / re-import on upstream change (provenance recorded to enable it later).
- Google Sheets, Slides, Forms exports.
- Server-side OAuth connection / background access.
- PDF (unsupported by the import pipeline generally).
