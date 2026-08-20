# Google Drive Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users import documents into a project from Google Drive — multi-select or a whole folder — via the Google Picker, reusing the existing import pipeline, with loud reporting of anything unsupported.

**Architecture:** A pure-logic module (`planDriveImport`, folder expansion, byte fetching) that is fully unit-tested, a thin untested DOM layer for the GIS/Picker popups, provenance recorded into the existing `importManifest` (projected server-side to `files.meta.aquillaImport` verbatim — no worker changes), and an `ImportDialog` panel that ends by calling the existing `handleFiles(File[])` so Paratext detection, collisions, preview, and R2 upload all come free.

**Tech Stack:** React 19 + TypeScript (no `any`), Google Identity Services token client + Google Picker (lazily loaded scripts), Drive REST v3 (`files.list`, `files/{id}?alt=media`, `files/{id}/export`), vitest (happy-dom), Playwright smoke.

**Spec:** `docs/superpowers/specs/2026-08-07-google-drive-import-design.md`

## Global Constraints

- Scope: `https://www.googleapis.com/auth/drive.file` only. NEVER `drive.readonly`.
- Folder expansion cap: 500 files total → loud error, never truncation.
- No silent drops: every skipped file appears with a human-readable reason.
- v1 native-Google support: Docs → DOCX export only. Sheets/Slides/Forms → skipped with "download as … and upload" reason.
- Env: `VITE_GOOGLE_CLIENT_ID`, `VITE_GOOGLE_API_KEY` (build-time). Unconfigured ⇒ panel shows a "not configured" notice (card stays visible).
- No worker or DB changes.
- Repo rules: TypeScript no `any`; files under ~500 lines; AGENTS.md testing rules (targeted tests during work, smoke suite at push).

---

### Task 1: Pure Drive logic module + tests

**Files:**
- Create: `src/lib/import/google-drive.ts`
- Test: `src/lib/import/google-drive.test.ts`

**Interfaces:**
- Consumes: `detectFileType` from `@/lib/parsers/types`.
- Produces (used by Tasks 3–4):
  - `interface DrivePickedItem { id: string; name: string; mimeType: string }`
  - `interface DriveDownloadTask { id: string; name: string; mimeType: string; action: "download" | "export-docx" }`
  - `interface DriveSkip { name: string; reason: string }`
  - `interface DriveImportPlan { accepted: DriveDownloadTask[]; skipped: DriveSkip[] }`
  - `GOOGLE_FOLDER_MIME`, `MAX_DRIVE_IMPORT_FILES = 500`
  - `planDriveImport(items: DrivePickedItem[]): DriveImportPlan`
  - `expandDriveFolders(items, listChildren): Promise<DrivePickedItem[]>` where `listChildren: (folderId: string, pageToken?: string) => Promise<{ files: DrivePickedItem[]; nextPageToken?: string }>`
  - `fetchDriveFile(task: DriveDownloadTask, accessToken: string, fetchImpl?: typeof fetch): Promise<File>`
  - `interface DriveOrigin { provider: "google-drive"; driveFileId: string; mimeType: string; exportedAs?: "docx" }`
  - `driveOrigin(task: DriveDownloadTask): DriveOrigin`

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/import/google-drive.test.ts
// Routing, folder expansion, and byte fetching for the Google Drive importer.
// Loud-drop invariant: every input item lands in either accepted or skipped.

import { describe, it, expect, vi } from "vitest"
import {
  planDriveImport,
  expandDriveFolders,
  fetchDriveFile,
  driveOrigin,
  MAX_DRIVE_IMPORT_FILES,
  GOOGLE_FOLDER_MIME,
  type DrivePickedItem,
} from "./google-drive"

const item = (over: Partial<DrivePickedItem>): DrivePickedItem => ({
  id: "f1", name: "doc.txt", mimeType: "text/plain", ...over,
})

describe("planDriveImport", () => {
  it("routes native Google Docs to DOCX export and appends .docx", () => {
    const plan = planDriveImport([
      item({ id: "d1", name: "My Draft", mimeType: "application/vnd.google-apps.document" }),
    ])
    expect(plan.accepted).toEqual([
      { id: "d1", name: "My Draft.docx", mimeType: "application/vnd.google-apps.document", action: "export-docx" },
    ])
    expect(plan.skipped).toEqual([])
  })

  it("keeps an existing .docx suffix on exported Docs", () => {
    const plan = planDriveImport([
      item({ name: "Draft.docx", mimeType: "application/vnd.google-apps.document" }),
    ])
    expect(plan.accepted[0].name).toBe("Draft.docx")
  })

  it("skips Sheets and Slides loudly with a workaround reason", () => {
    const plan = planDriveImport([
      item({ name: "Budget", mimeType: "application/vnd.google-apps.spreadsheet" }),
      item({ name: "Deck", mimeType: "application/vnd.google-apps.presentation" }),
    ])
    expect(plan.accepted).toEqual([])
    expect(plan.skipped).toEqual([
      { name: "Budget", reason: "Google Sheets aren't supported yet — download as .xlsx and upload it instead." },
      { name: "Deck", reason: "Google Slides aren't supported yet — download as .pptx and upload it instead." },
    ])
  })

  it("skips other native Google types with a generic reason", () => {
    const plan = planDriveImport([
      item({ name: "Survey", mimeType: "application/vnd.google-apps.form" }),
    ])
    expect(plan.skipped).toEqual([
      { name: "Survey", reason: "This Google file type can't be imported." },
    ])
  })

  it("accepts regular files whose extension the pipeline supports", () => {
    const plan = planDriveImport([
      item({ id: "u1", name: "GEN.usfm", mimeType: "application/octet-stream" }),
      item({ id: "u2", name: "notes.md", mimeType: "text/markdown" }),
    ])
    expect(plan.accepted.map((t) => t.action)).toEqual(["download", "download"])
    expect(plan.skipped).toEqual([])
  })

  it("skips unsupported extensions loudly, naming the extension", () => {
    const plan = planDriveImport([item({ name: "scan.pdf", mimeType: "application/pdf" })])
    expect(plan.skipped).toEqual([
      { name: "scan.pdf", reason: "Unsupported file type (.pdf)." },
    ])
  })

  it("never drops an item silently: accepted + skipped covers every non-folder input", () => {
    const items = [
      item({ id: "a", name: "a.txt" }),
      item({ id: "b", name: "b.xyz" }),
      item({ id: "c", name: "Doc", mimeType: "application/vnd.google-apps.document" }),
    ]
    const plan = planDriveImport(items)
    expect(plan.accepted.length + plan.skipped.length).toBe(items.length)
  })
})

describe("expandDriveFolders", () => {
  const folder = (id: string, name = id): DrivePickedItem => ({
    id, name, mimeType: GOOGLE_FOLDER_MIME,
  })

  it("passes plain files through and expands folders recursively with pagination", async () => {
    const pages: Record<string, { files: DrivePickedItem[]; nextPageToken?: string }[]> = {
      root: [
        { files: [item({ id: "x", name: "x.txt" }), folder("sub")], nextPageToken: "p2" },
        { files: [item({ id: "y", name: "y.txt" })] },
      ],
      sub: [{ files: [item({ id: "z", name: "z.txt" })] }],
    }
    const calls: string[] = []
    const listChildren = vi.fn(async (folderId: string, pageToken?: string) => {
      calls.push(`${folderId}:${pageToken ?? ""}`)
      const queue = pages[folderId]
      return pageToken === "p2" ? queue[1] : queue[0]
    })
    const out = await expandDriveFolders([item({ id: "top", name: "top.md" }), folder("root")], listChildren)
    expect(out.map((f) => f.id).sort()).toEqual(["top", "x", "y", "z"])
    expect(calls).toContain("root:p2")
  })

  it("throws a loud error past the file cap instead of truncating", async () => {
    const many = Array.from({ length: MAX_DRIVE_IMPORT_FILES + 1 }, (_, i) =>
      item({ id: `f${i}`, name: `f${i}.txt` }),
    )
    const listChildren = vi.fn(async () => ({ files: many }))
    await expect(expandDriveFolders([folder("big")], listChildren)).rejects.toThrow(
      /more than 500 files/i,
    )
  })
})

describe("fetchDriveFile", () => {
  it("downloads regular files via alt=media with the bearer token", async () => {
    const fetchImpl = vi.fn(async () => new Response(new Blob(["hello"]), { status: 200 }))
    const file = await fetchDriveFile(
      { id: "f9", name: "a.txt", mimeType: "text/plain", action: "download" },
      "tok-1",
      fetchImpl as unknown as typeof fetch,
    )
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe("https://www.googleapis.com/drive/v3/files/f9?alt=media")
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok-1")
    expect(file.name).toBe("a.txt")
    expect(await file.text()).toBe("hello")
  })

  it("exports native Docs as DOCX via the export endpoint", async () => {
    const fetchImpl = vi.fn(async () => new Response(new Blob(["bytes"]), { status: 200 }))
    await fetchDriveFile(
      { id: "d1", name: "Draft.docx", mimeType: "application/vnd.google-apps.document", action: "export-docx" },
      "tok-1",
      fetchImpl as unknown as typeof fetch,
    )
    const [url] = fetchImpl.mock.calls[0] as unknown as [string]
    expect(url).toBe(
      "https://www.googleapis.com/drive/v3/files/d1/export?mimeType=application%2Fvnd.openxmlformats-officedocument.wordprocessingml.document",
    )
  })

  it("surfaces HTTP failures with the file name and status", async () => {
    const fetchImpl = vi.fn(async () => new Response("too big", { status: 403 }))
    await expect(
      fetchDriveFile(
        { id: "d1", name: "Huge.docx", mimeType: "application/vnd.google-apps.document", action: "export-docx" },
        "tok-1",
        fetchImpl as unknown as typeof fetch,
      ),
    ).rejects.toThrow(/Huge\.docx.*403/)
  })
})

describe("driveOrigin", () => {
  it("records provider, id, mimeType, and export marker", () => {
    expect(
      driveOrigin({ id: "d1", name: "Draft.docx", mimeType: "application/vnd.google-apps.document", action: "export-docx" }),
    ).toEqual({ provider: "google-drive", driveFileId: "d1", mimeType: "application/vnd.google-apps.document", exportedAs: "docx" })
    expect(
      driveOrigin({ id: "f2", name: "a.txt", mimeType: "text/plain", action: "download" }),
    ).toEqual({ provider: "google-drive", driveFileId: "f2", mimeType: "text/plain" })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/lib/import/google-drive.test.ts`
Expected: FAIL — module `./google-drive` not found.

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/import/google-drive.ts
// Pure logic for the Google Drive importer: routing picked items to
// download/export/skip, recursive folder expansion, and byte fetching.
// The DOM/popup layer (GIS + Picker) lives in google-drive-picker.ts so this
// module stays unit-testable. Loud-drop invariant: planDriveImport places
// every input in either `accepted` or `skipped` — nothing vanishes.

import { detectFileType } from "@/lib/parsers/types"

export interface DrivePickedItem {
  id: string
  name: string
  mimeType: string
}

export interface DriveDownloadTask {
  id: string
  name: string
  mimeType: string
  action: "download" | "export-docx"
}

export interface DriveSkip {
  name: string
  reason: string
}

export interface DriveImportPlan {
  accepted: DriveDownloadTask[]
  skipped: DriveSkip[]
}

/** Provenance stamped into files.meta.aquillaImport.origin — the hook a
 *  future linked-sync mode needs to find the upstream Drive doc. */
export interface DriveOrigin {
  provider: "google-drive"
  driveFileId: string
  mimeType: string
  exportedAs?: "docx"
}

export const GOOGLE_FOLDER_MIME = "application/vnd.google-apps.folder"
const GOOGLE_DOC_MIME = "application/vnd.google-apps.document"
const GOOGLE_NATIVE_PREFIX = "application/vnd.google-apps."
const DOCX_EXPORT_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

/** Hard cap on total files after folder expansion. Exceeding it throws —
 *  never truncate silently. */
export const MAX_DRIVE_IMPORT_FILES = 500

const NATIVE_SKIP_REASONS: Record<string, string> = {
  "application/vnd.google-apps.spreadsheet":
    "Google Sheets aren't supported yet — download as .xlsx and upload it instead.",
  "application/vnd.google-apps.presentation":
    "Google Slides aren't supported yet — download as .pptx and upload it instead.",
}

export function planDriveImport(items: DrivePickedItem[]): DriveImportPlan {
  const accepted: DriveDownloadTask[] = []
  const skipped: DriveSkip[] = []
  for (const it of items) {
    if (it.mimeType === GOOGLE_DOC_MIME) {
      const name = /\.docx$/i.test(it.name) ? it.name : `${it.name}.docx`
      accepted.push({ id: it.id, name, mimeType: it.mimeType, action: "export-docx" })
      continue
    }
    if (it.mimeType.startsWith(GOOGLE_NATIVE_PREFIX)) {
      skipped.push({
        name: it.name,
        reason: NATIVE_SKIP_REASONS[it.mimeType] ?? "This Google file type can't be imported.",
      })
      continue
    }
    if (detectFileType(it.name) === null) {
      const ext = /\.[^.]+$/.exec(it.name)?.[0]?.toLowerCase()
      skipped.push({
        name: it.name,
        reason: ext ? `Unsupported file type (${ext}).` : "Unsupported file type.",
      })
      continue
    }
    accepted.push({ id: it.id, name: it.name, mimeType: it.mimeType, action: "download" })
  }
  return { accepted, skipped }
}

export type DriveListPage = { files: DrivePickedItem[]; nextPageToken?: string }

/** Breadth-first expansion of picked folders into their files. `listChildren`
 *  is injected so tests (and the picker layer) own the HTTP call. */
export async function expandDriveFolders(
  items: DrivePickedItem[],
  listChildren: (folderId: string, pageToken?: string) => Promise<DriveListPage>,
): Promise<DrivePickedItem[]> {
  const files: DrivePickedItem[] = []
  const queue: string[] = []
  for (const it of items) {
    if (it.mimeType === GOOGLE_FOLDER_MIME) queue.push(it.id)
    else files.push(it)
  }
  while (queue.length > 0) {
    const folderId = queue.shift() as string
    let pageToken: string | undefined
    do {
      const page = await listChildren(folderId, pageToken)
      for (const child of page.files) {
        if (child.mimeType === GOOGLE_FOLDER_MIME) queue.push(child.id)
        else files.push(child)
      }
      if (files.length > MAX_DRIVE_IMPORT_FILES) {
        throw new Error(
          `That selection contains more than ${MAX_DRIVE_IMPORT_FILES} files. ` +
            "Pick a smaller folder or select files directly.",
        )
      }
      pageToken = page.nextPageToken
    } while (pageToken)
  }
  return files
}

export async function fetchDriveFile(
  task: DriveDownloadTask,
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<File> {
  const url =
    task.action === "export-docx"
      ? `https://www.googleapis.com/drive/v3/files/${task.id}/export?mimeType=${encodeURIComponent(DOCX_EXPORT_MIME)}`
      : `https://www.googleapis.com/drive/v3/files/${task.id}?alt=media`
  const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${accessToken}` } })
  if (!res.ok) {
    throw new Error(
      `Google Drive ${task.action === "export-docx" ? "export" : "download"} failed for ` +
        `${task.name} (HTTP ${res.status}).`,
    )
  }
  const blob = await res.blob()
  return new File([blob], task.name)
}

export function driveOrigin(task: DriveDownloadTask): DriveOrigin {
  return {
    provider: "google-drive",
    driveFileId: task.id,
    mimeType: task.mimeType,
    ...(task.action === "export-docx" ? { exportedAs: "docx" as const } : {}),
  }
}
```

Note: if `detectFileType` returns `undefined` rather than `null` for unknown names (check its signature in `src/lib/parsers/types.ts:741`), compare with `== null` instead and keep the tests as written.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/lib/import/google-drive.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/import/google-drive.ts src/lib/import/google-drive.test.ts
git commit -m "feat(import): Google Drive routing, folder expansion, and fetch logic"
```

---

### Task 2: Provenance plumbing into importManifest

**Files:**
- Modify: `src/lib/import.ts` (`ImportContext` at :444; the two `summarizeNormalizedImport(` call sites at ~:1509 and ~:2145)
- Test: `src/lib/import.test.ts` (append one test to the existing `describe("import — bulk upload")`)

**Interfaces:**
- Consumes: existing `emitParsedFile` / `importFile` in `src/lib/import.ts`; `summarizeNormalizedImport` from `./import/normalized-manifest`.
- Produces: `ImportContext.origins?: ReadonlyMap<string, Record<string, unknown>>` — keyed by **normalized file name** (`name.trim().toLowerCase()`, the same vocabulary as `skipKeys`). When a key matches the imported file's name, the origin object is stamped as `importManifest.origin` and lands server-side at `files.meta.aquillaImport.origin` (the server projects `importManifest` verbatim — verified in `sync-worker/src/events/import-route.ts:541` and `event-projection.ts:1107`; no worker change needed).

- [ ] **Step 1: Write the failing test**

Append to `src/lib/import.test.ts` inside `describe("import — bulk upload")` (the file's existing fetch mock captures the bulk POST bodies in `captured`):

```ts
  it("stamps ctx.origins into importManifest.origin for the matching file", async () => {
    await emitParsedFile(
      {
        name: "notes.md",
        strings: [makeString("s1", "Hello", "g1")],
      },
      "markdown",
      {
        projectId: "p-1",
        author: "alice",
        getToken,
        origins: new Map([
          ["notes.md", { provider: "google-drive", driveFileId: "d42", mimeType: "text/markdown" }],
        ]),
      },
    )
    const withFile = captured.find((body) => body.file !== undefined)
    expect(withFile?.file?.importManifest?.origin).toEqual({
      provider: "google-drive",
      driveFileId: "d42",
      mimeType: "text/markdown",
    })
  })
```

Note: the second argument to `emitParsedFile` is the `FileType`; if markdown's `FileType` literal is `"md"` rather than `"markdown"` (check `src/lib/parsers/types.ts:3`), use that literal.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/lib/import.test.ts -t "stamps ctx.origins"`
Expected: FAIL — `origins` is not a known `ImportContext` property (type error) or `origin` is `undefined`.

- [ ] **Step 3: Implement**

In `src/lib/import.ts`:

1. Add to `ImportContext` (after `reimportFileIds`):

```ts
  /** Per-file import provenance, keyed by normalized file name
   *  (`name.trim().toLowerCase()` — the skipKeys vocabulary). A matching
   *  entry is stamped as `importManifest.origin` and projected verbatim to
   *  `files.meta.aquillaImport.origin` (linked-sync hook, e.g. Google Drive). */
  origins?: ReadonlyMap<string, Record<string, unknown>>
```

2. Add a small helper near `importedFileKind`:

```ts
/** Merge caller-supplied provenance into the versioned import summary. */
function manifestWithOrigin(
  manifest: object,
  origins: ReadonlyMap<string, Record<string, unknown>> | undefined,
  fileName: string,
): object {
  const origin = origins?.get(fileName.trim().toLowerCase())
  return origin ? { ...manifest, origin } : manifest
}
```

3. At **both** `summarizeNormalizedImport(` call sites (~:1509 and ~:2145 — `grep -n "summarizeNormalizedImport(" src/lib/import.ts` to confirm), wrap the value:

```ts
importManifest: manifestWithOrigin(summarizeNormalizedImport(normalized), ctx.origins, result.name),
```

using whichever local variable holds the `ImportResult` name at that site (`result.name` / `file.name` — match the surrounding code; the name used must be the one that becomes `BulkImportFileMeta.name`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/lib/import.test.ts`
Expected: PASS — the new test and all pre-existing tests in the file.

- [ ] **Step 5: Commit**

```bash
git add src/lib/import.ts src/lib/import.test.ts
git commit -m "feat(import): per-file origin provenance stamped into importManifest"
```

---

### Task 3: GIS/Picker DOM layer

**Files:**
- Create: `src/lib/import/google-drive-picker.ts`

**Interfaces:**
- Consumes: `DrivePickedItem`, `DriveListPage` from `./google-drive`; `import.meta.env.VITE_GOOGLE_CLIENT_ID` / `VITE_GOOGLE_API_KEY`.
- Produces (used by Task 4):
  - `googleDriveConfig(): { clientId: string; apiKey: string } | null` — null when either env var is missing.
  - `requestDriveAccessToken(clientId: string): Promise<string>` — GIS popup, scope `drive.file`; rejects on denial/close.
  - `openDrivePicker(args: { accessToken: string; apiKey: string }): Promise<DrivePickedItem[]>` — resolves `[]` on cancel.
  - `listDriveChildren(accessToken: string): (folderId: string, pageToken?: string) => Promise<DriveListPage>` — curried for `expandDriveFolders`.

This layer is intentionally thin and **not unit tested** (popup windows + third-party script loading can't run in happy-dom or CI). All routing decisions stay in Task 1's tested module. Manual QA covers this file (Task 6).

- [ ] **Step 1: Implement**

```ts
// src/lib/import/google-drive-picker.ts
// Thin DOM layer for Google Drive import: lazy script loading, the GIS
// token popup, and the Picker dialog. Deliberately free of routing logic —
// everything decidable is in google-drive.ts where it can be unit tested.
// Scope is drive.file ONLY: access is limited to items the user picks,
// which keeps us out of Google's restricted-scope verification.

import type { DriveListPage, DrivePickedItem } from "./google-drive"
import { GOOGLE_FOLDER_MIME } from "./google-drive"

const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file"

// Minimal typings for the two Google globals we touch (no `any`).
interface GisTokenResponse { access_token?: string; error?: string }
interface GisTokenClient { requestAccessToken: () => void }
interface GoogleGlobal {
  accounts: {
    oauth2: {
      initTokenClient: (config: {
        client_id: string
        scope: string
        callback: (response: GisTokenResponse) => void
        error_callback?: (error: { type: string }) => void
      }) => GisTokenClient
    }
  }
  picker: {
    Action: { PICKED: string; CANCEL: string }
    Feature: { MULTISELECT_ENABLED: string }
    ViewId: { DOCS: string }
    DocsView: new (viewId?: string) => {
      setIncludeFolders: (v: boolean) => unknown
      setSelectFolderEnabled: (v: boolean) => unknown
      setOwnedByMe?: (v: boolean) => unknown
    }
    PickerBuilder: new () => {
      addView: (view: unknown) => PickerBuilderish
      setOAuthToken: (token: string) => PickerBuilderish
      setDeveloperKey: (key: string) => PickerBuilderish
      enableFeature: (feature: string) => PickerBuilderish
      setCallback: (cb: (data: PickerCallbackData) => void) => PickerBuilderish
      build: () => { setVisible: (v: boolean) => void }
    }
  }
}
type PickerBuilderish = GoogleGlobal["picker"]["PickerBuilder"]["prototype"]
interface PickerDoc { id: string; name: string; mimeType: string }
interface PickerCallbackData { action: string; docs?: PickerDoc[] }
interface GapiGlobal { load: (api: string, cb: () => void) => void }

declare global {
  interface Window {
    google?: GoogleGlobal
    gapi?: GapiGlobal
  }
}

export function googleDriveConfig(): { clientId: string; apiKey: string } | null {
  const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined
  const apiKey = import.meta.env.VITE_GOOGLE_API_KEY as string | undefined
  return clientId && apiKey ? { clientId, apiKey } : null
}

const loadedScripts = new Map<string, Promise<void>>()

function loadScript(src: string): Promise<void> {
  const existing = loadedScripts.get(src)
  if (existing) return existing
  const promise = new Promise<void>((resolve, reject) => {
    const el = document.createElement("script")
    el.src = src
    el.async = true
    el.onload = () => resolve()
    el.onerror = () => {
      loadedScripts.delete(src)
      reject(new Error(`Failed to load ${src} — check your network and try again.`))
    }
    document.head.appendChild(el)
  })
  loadedScripts.set(src, promise)
  return promise
}

async function ensureGis(): Promise<GoogleGlobal["accounts"]> {
  await loadScript("https://accounts.google.com/gsi/client")
  const accounts = window.google?.accounts
  if (!accounts) throw new Error("Google sign-in failed to initialize.")
  return accounts
}

async function ensurePicker(): Promise<GoogleGlobal["picker"]> {
  await loadScript("https://apis.google.com/js/api.js")
  const gapi = window.gapi
  if (!gapi) throw new Error("Google Picker failed to initialize.")
  await new Promise<void>((resolve) => gapi.load("picker", resolve))
  const picker = window.google?.picker
  if (!picker) throw new Error("Google Picker failed to initialize.")
  return picker
}

export async function requestDriveAccessToken(clientId: string): Promise<string> {
  const accounts = await ensureGis()
  return new Promise<string>((resolve, reject) => {
    const client = accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: DRIVE_SCOPE,
      callback: (response) => {
        if (response.access_token) resolve(response.access_token)
        else reject(new Error(response.error ?? "Google sign-in was cancelled."))
      },
      error_callback: (error) => reject(new Error(`Google sign-in failed (${error.type}).`)),
    })
    client.requestAccessToken()
  })
}

export async function openDrivePicker(args: {
  accessToken: string
  apiKey: string
}): Promise<DrivePickedItem[]> {
  const picker = await ensurePicker()
  return new Promise<DrivePickedItem[]>((resolve) => {
    const view = new picker.DocsView(picker.ViewId.DOCS)
    view.setIncludeFolders(true)
    view.setSelectFolderEnabled(true)
    const dialog = new picker.PickerBuilder()
      .addView(view)
      .setOAuthToken(args.accessToken)
      .setDeveloperKey(args.apiKey)
      .enableFeature(picker.Feature.MULTISELECT_ENABLED)
      .setCallback((data) => {
        if (data.action === picker.Action.PICKED) {
          resolve(
            (data.docs ?? []).map((d) => ({ id: d.id, name: d.name, mimeType: d.mimeType })),
          )
        } else if (data.action === picker.Action.CANCEL) {
          resolve([])
        }
      })
      .build()
    dialog.setVisible(true)
  })
}

/** Curried Drive children lister for expandDriveFolders. */
export function listDriveChildren(
  accessToken: string,
): (folderId: string, pageToken?: string) => Promise<DriveListPage> {
  return async (folderId, pageToken) => {
    const params = new URLSearchParams({
      q: `'${folderId}' in parents and trashed = false`,
      fields: "nextPageToken, files(id, name, mimeType)",
      pageSize: "100",
    })
    if (pageToken) params.set("pageToken", pageToken)
    const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!res.ok) throw new Error(`Listing the Drive folder failed (HTTP ${res.status}).`)
    const body = (await res.json()) as {
      files?: { id: string; name: string; mimeType: string }[]
      nextPageToken?: string
    }
    return {
      files: (body.files ?? []).map((f) => ({ id: f.id, name: f.name, mimeType: f.mimeType })),
      nextPageToken: body.nextPageToken,
    }
  }
}

// Re-exported so the panel needs only this module for folder checks.
export { GOOGLE_FOLDER_MIME }
```

- [ ] **Step 2: Verify it compiles**

Run: `pnpm build`
Expected: `tsc -b` and `vite build` succeed (this is the CI gate — do not substitute `tsc --noEmit`).

- [ ] **Step 3: Commit**

```bash
git add src/lib/import/google-drive-picker.ts
git commit -m "feat(import): GIS token + Google Picker DOM layer for Drive import"
```

---

### Task 4: GoogleDrivePanel + ImportDialog wiring

**Files:**
- Create: `src/components/import/GoogleDrivePanel.tsx`
- Modify: `src/components/ImportDialog.tsx` — `Screen` union (:112), `POPULAR_OPTIONS` (~:841), the shared `ctx` (:1543), and the screen-render switch (find where `screen === "ebible"` renders its panel and mirror it).

**Interfaces:**
- Consumes: Tasks 1–3 exports; `handleFiles` (ImportDialog :1084).
- Produces: `<GoogleDrivePanel onFiles={(files, origins) => …} />` where `origins` is `Map<string, Record<string, unknown>>` keyed by normalized file name — stored in a ref and passed as `ctx.origins`.

- [ ] **Step 1: Implement the panel**

```tsx
// src/components/import/GoogleDrivePanel.tsx
// Google Drive import panel: connect → pick (files or folders) → pre-import
// summary (accepted + loudly-listed skips) → download → hand File[] to the
// dialog's normal handleFiles path. No import logic lives here.

import { useCallback, useState } from "react"
import { AlertTriangle, CloudDownload, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  planDriveImport,
  expandDriveFolders,
  fetchDriveFile,
  driveOrigin,
  type DriveImportPlan,
} from "@/lib/import/google-drive"
import {
  googleDriveConfig,
  requestDriveAccessToken,
  openDrivePicker,
  listDriveChildren,
} from "@/lib/import/google-drive-picker"

type Stage =
  | { kind: "idle" }
  | { kind: "picking" }
  | { kind: "summary"; plan: DriveImportPlan; accessToken: string }
  | { kind: "downloading"; done: number; total: number }

export function GoogleDrivePanel({
  onFiles,
}: {
  /** Hands downloaded files plus per-file provenance to the dialog's
   *  standard import path. Keys are normalized file names. */
  onFiles: (files: File[], origins: Map<string, Record<string, unknown>>) => void | Promise<void>
}) {
  const config = googleDriveConfig()
  const [stage, setStage] = useState<Stage>({ kind: "idle" })
  const [error, setError] = useState<string | null>(null)

  const pick = useCallback(async () => {
    if (!config) return
    setError(null)
    setStage({ kind: "picking" })
    try {
      const accessToken = await requestDriveAccessToken(config.clientId)
      const picked = await openDrivePicker({ accessToken, apiKey: config.apiKey })
      if (picked.length === 0) {
        setStage({ kind: "idle" })
        return
      }
      const expanded = await expandDriveFolders(picked, listDriveChildren(accessToken))
      setStage({ kind: "summary", plan: planDriveImport(expanded), accessToken })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setStage({ kind: "idle" })
    }
  }, [config])

  const confirm = useCallback(async () => {
    if (stage.kind !== "summary") return
    const { plan, accessToken } = stage
    setError(null)
    setStage({ kind: "downloading", done: 0, total: plan.accepted.length })
    try {
      const files: File[] = []
      const origins = new Map<string, Record<string, unknown>>()
      for (const task of plan.accepted) {
        const file = await fetchDriveFile(task, accessToken)
        files.push(file)
        origins.set(file.name.trim().toLowerCase(), { ...driveOrigin(task) })
        setStage({ kind: "downloading", done: files.length, total: plan.accepted.length })
      }
      await onFiles(files, origins)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setStage({ kind: "summary", plan, accessToken })
    }
  }, [stage, onFiles])

  if (!config) {
    return (
      <div className="rounded-md border border-dashed p-6 text-sm text-muted-foreground">
        Google Drive import isn't configured for this deployment
        (missing VITE_GOOGLE_CLIENT_ID / VITE_GOOGLE_API_KEY).
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {error && (
        <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {(stage.kind === "idle" || stage.kind === "picking") && (
        <div className="flex flex-col items-start gap-2">
          <p className="text-sm text-muted-foreground">
            Pick files or a whole folder from your Google Drive. Only the items
            you pick are shared with Aquilla.
          </p>
          <Button onClick={pick} disabled={stage.kind === "picking"}>
            {stage.kind === "picking"
              ? <><Loader2 className="mr-2 size-4 animate-spin" /> Waiting for Google…</>
              : <><CloudDownload className="mr-2 size-4" /> Choose from Google Drive</>}
          </Button>
        </div>
      )}

      {stage.kind === "summary" && (
        <div className="space-y-3">
          <div>
            <h4 className="text-sm font-medium">Will import ({stage.plan.accepted.length})</h4>
            <ul className="mt-1 max-h-40 overflow-y-auto text-sm text-muted-foreground">
              {stage.plan.accepted.map((t) => <li key={t.id}>{t.name}</li>)}
            </ul>
          </div>
          {stage.plan.skipped.length > 0 && (
            <div role="alert">
              <h4 className="flex items-center gap-1.5 text-sm font-medium text-amber-600 dark:text-amber-400">
                <AlertTriangle className="size-4" /> Skipped ({stage.plan.skipped.length})
              </h4>
              <ul className="mt-1 max-h-40 overflow-y-auto text-sm text-muted-foreground">
                {stage.plan.skipped.map((s) => (
                  <li key={s.name}><span className="font-medium">{s.name}</span> — {s.reason}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="flex gap-2">
            <Button onClick={confirm} disabled={stage.plan.accepted.length === 0}>
              Import {stage.plan.accepted.length} file{stage.plan.accepted.length === 1 ? "" : "s"}
            </Button>
            <Button variant="outline" onClick={() => setStage({ kind: "idle" })}>Back</Button>
          </div>
        </div>
      )}

      {stage.kind === "downloading" && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Downloading {stage.done}/{stage.total} from Google Drive…
        </p>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Wire into ImportDialog**

In `src/components/ImportDialog.tsx`:

1. `Screen` union (:112): add `"gdrive"`.
2. `POPULAR_OPTIONS` (~:841): add after the "Upload files" entry (import `CloudDownload` from lucide alongside the existing icon imports):

```ts
  { id: "gdrive", title: "Google Drive", hint: "files or a folder", icon: CloudDownload, badge: "beta",
    description: "Pick documents or a whole folder from your Drive — Google Docs import as DOCX." },
```

3. Add a ref near the other refs and thread it through the shared ctx (:1543):

```ts
const driveOriginsRef = useRef<Map<string, Record<string, unknown>> | null>(null)
// …
const ctx = { projectId, author: username, sourceLanguage, targetLanguage, targetLang, getToken,
  origins: driveOriginsRef.current ?? undefined }
```

Note: :1543's `ctx` may be scoped to a specific panel — the authoritative wiring point is wherever `importFile(file, ctx…)` is called for `handleFiles`-originated uploads (inside `doImportFiles`). Ensure THAT context object gets `origins: driveOriginsRef.current ?? undefined`; clear the ref (`driveOriginsRef.current = null`) after `doImportFiles` completes or errors, so a later plain upload doesn't inherit stale Drive provenance.

4. Render the panel where the other screens render (mirror the `ebible` branch; lazy-import the panel the same way other subpanels are imported):

```tsx
{screen === "gdrive" && (
  <GoogleDrivePanel
    onFiles={async (files, origins) => {
      driveOriginsRef.current = origins
      await handleFiles(files)
    }}
  />
)}
```

Follow the surrounding screens' conventions for the back-to-landing header/button.

- [ ] **Step 3: Verify compile + lint + affected tests**

Run: `pnpm build && pnpm lint && pnpm test src/lib/import.test.ts src/lib/import/google-drive.test.ts`
Expected: all pass.

- [ ] **Step 4: Visual sanity check in the dev stack**

With `pnpm dev` running, navigate to `http://127.0.0.1:5173/__dev/login`, open the project's import dialog, and confirm: the "Google Drive" card renders in the popular tier; clicking it shows the panel (the "isn't configured" notice locally unless env vars are set). Screenshot for the PR.

- [ ] **Step 5: Commit**

```bash
git add src/components/import/GoogleDrivePanel.tsx src/components/ImportDialog.tsx
git commit -m "feat(import): Google Drive panel with folder pick and loud skip summary"
```

---

### Task 5: Smoke spec + JOURNEYS.md

**Files:**
- Modify: `e2e/specs/editor/import-dialog.smoke.spec.ts`
- Modify: `e2e/JOURNEYS.md`

The OAuth popup can't run in the harness (documented product gap — external Google dependency), so smoke coverage asserts the deterministic part: the card exists and routes to the panel.

- [ ] **Step 1: Extend the smoke spec**

Read `e2e/specs/editor/import-dialog.smoke.spec.ts` first and follow its existing structure/page objects. Add, alongside the existing option-card assertions:

```ts
test("shows the Google Drive import option and its panel", async ({ page }) => {
  // …reuse the spec's existing dialog-open steps/page object…
  await expect(page.getByRole("button", { name: /Google Drive/ })).toBeVisible()
  await page.getByRole("button", { name: /Google Drive/ }).click()
  // e2e stack has no VITE_GOOGLE_CLIENT_ID → deterministic unconfigured notice.
  await expect(page.getByText(/isn't configured for this deployment/)).toBeVisible()
})
```

(Adjust the role/selector to match how the spec targets the other option cards — cards are `role="button"` Cards, see `OptionCard` in ImportDialog. Do not add timeouts; wait on visible state only.)

- [ ] **Step 2: Run the targeted spec**

Run: `npx tsx scripts/e2e-up.ts -- e2e/specs/editor/import-dialog.smoke.spec.ts`
Expected: PASS. (Note the machine-level rule: only one e2e stack at a time.)

- [ ] **Step 3: Add the JOURNEYS.md row**

```md
| Editor      | Import dialog offers Google Drive; picker/OAuth flow itself is manual-QA only (external Google dependency) | `e2e/specs/editor/import-dialog.smoke.spec.ts` |   ✅   |
```

- [ ] **Step 4: Commit**

```bash
git add e2e/specs/editor/import-dialog.smoke.spec.ts e2e/JOURNEYS.md
git commit -m "test(e2e): cover Google Drive import entry point"
```

---

### Task 6: PR with QA checklist

- [ ] **Step 1: Full gates**

Run: `pnpm build && pnpm lint && pnpm test`
Expected: all green. Then push (the pre-push hook runs the smoke suite — let it).

- [ ] **Step 2: Open PR to dev**

```bash
git push -u origin ryder/google-drive-import
gh pr create --base dev --title "feat(import): Google Drive import (picker, folders, loud skips)" --body "$(cat <<'EOF'
## What

Import documents from Google Drive: a new **Google Drive** card in the import dialog opens the Google Picker (multi-select + folder selection, `drive.file` scope only — access is limited to what the user picks). Native Google Docs export as DOCX; regular Drive files download as-is and flow through the existing import pipeline (sniffing, preview, collisions, R2). A pre-import summary lists everything that will import and **loudly lists every skipped file with a reason** (Sheets/Slides, unsupported types) — nothing is dropped silently. Folder expansion is capped at 500 files with a hard error. Each imported file records Drive provenance in `files.meta.aquillaImport.origin` for a future linked-sync mode.

One-time import only (v1). No worker or DB changes. Spec: `docs/superpowers/specs/2026-08-07-google-drive-import-design.md`.

## Setup required before this works in an environment

Create a Google Cloud OAuth client (web) + API key with the Picker API enabled, then set build-time `VITE_GOOGLE_CLIENT_ID` and `VITE_GOOGLE_API_KEY`. Unconfigured deployments show a clear notice instead of the connect button.

## QA checklist (manual — OAuth can't run in e2e)

- [ ] With env vars set: Import → Google Drive → Google sign-in popup → pick 2–3 files (mixed: a Google Doc, a .usfm/.md, a PDF) → summary shows the PDF under **Skipped** with a reason → confirm → files appear in the project; the Google Doc arrives as DOCX.
- [ ] Pick a **folder** → contents expand; skipped items listed; import succeeds. (If folder children 403 under `drive.file`, that's the known risk in the spec — report back and we ship files-only.)
- [ ] Cancel the picker → panel returns to idle, no error.
- [ ] Without env vars: card visible, panel shows the "isn't configured" notice.
- [ ] Re-import the same file → existing collision dialog appears (unchanged behavior).

## Test-impact analysis

Changed contract: `ImportContext` gains optional `origins`; `importManifest` gains optional `origin` (additive, projected verbatim by the existing sync-worker `/import` route — no server change). Producers: GoogleDrivePanel; consumers: `emitParsedFile` → bulk `/import`. Regression tests: `src/lib/import/google-drive.test.ts` (routing/expansion/fetch), new `importManifest.origin` assertion in `src/lib/import.test.ts` (real emit path through the mocked bulk endpoint), extended `import-dialog.smoke.spec.ts` (entry point). Commands run: targeted vitest files, targeted smoke spec, full `pnpm test` + smoke suite at push.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-review notes

- Spec coverage: import model ✅ (Task 4 hands to existing pipeline), auth ✅ (Task 3, `drive.file` only), Docs→DOCX + regular files ✅ (Task 1 routing), folder expansion + 500 cap ✅ (Task 1), loud skip summary ✅ (Tasks 1 & 4), provenance ✅ (Task 2 — via `importManifest`, NOT `ImportSourceLocator`, which turned out to be per-cell; spec's mechanism note superseded here), 10 MB export limit ✅ (surfaces as the per-file HTTP-error path in `fetchDriveFile`; no reliable pre-check exists since export size is unknowable up front), unconfigured env ✅ (Task 4 notice), known folder-children risk ✅ (QA checklist item), testing rules ✅ (Task 5 + AGENTS.md analysis in PR body).
- Type consistency: `DrivePickedItem`/`DriveDownloadTask`/`DriveImportPlan`/`DriveListPage` names match across Tasks 1, 3, 4; `origins` map key vocabulary (`name.trim().toLowerCase()`) stated identically in Tasks 2 and 4.
- Two verify-at-site notes are flagged inline (the `detectFileType` null-vs-undefined return, the exact `FileType` literal for markdown, and the authoritative `ctx` wiring point in ImportDialog) — these are look-before-edit instructions, not placeholders.
