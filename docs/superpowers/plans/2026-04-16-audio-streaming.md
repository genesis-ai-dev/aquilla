# Audio Streaming (Read-Only) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Play per-cell audio attachments stored in cloned git projects by parsing the LFS pointer already captured in the Y.Doc, fetching bytes via GitLab's LFS batch API through the existing `codex-git-proxy` worker, caching in OPFS, and exposing a compact ▶/⏸ button in each cell row.

**Architecture:** Pure pointer parser + pure HTTP-mocked download client + OPFS blob cache keyed on oid, composed by a React hook (`useCellAudio`) that owns the `HTMLAudioElement` lifecycle. A thin button component reads the hook and renders one of four visual states. No backend work required.

**Tech Stack:** TypeScript, React, OPFS (via existing `createOpfsFs`), `SubtleCrypto` SHA-256, `fetch` + `AbortController`, Vitest.

**Spec:** `docs/superpowers/specs/2026-04-16-codex-web-app-audio-streaming-design.md`

**Reference code:**
- `/Users/ryderwishart/frontierrnd/codex-editor/src/utils/lfsHelpers.ts:68-97` — pointer parser
- `/Users/ryderwishart/frontierrnd/frontier-authentication/src/git/GitService.ts:648-728` — LFS batch flow
- `src/lib/git/opfs-fs.ts` — existing OPFS fs wrapper (reuse for cache)
- `src/lib/git/clone.ts:6` — `GIT_CORS_PROXY` constant
- `src/lib/sync/git-sync.ts:61` — auth header construction pattern

---

## File structure

**New files**
```
src/lib/lfs/
  pointer.ts                                    # parsePointerContent + isLfsPointerContent
  download.ts                                   # downloadLfsBlob (batch + GET + sha256 verify)
  cache.ts                                      # lfsCacheGet / lfsCachePut
  __test__/
    pointer.test.ts
    cache.test.ts
    download.test.ts

src/hooks/
  useCellAudio.ts                               # React hook: idle → loading → ready | error
  useCellAudio.test.tsx                         # hook integration tests

src/components/
  CellAudioButton.tsx                           # ▶/⏸ button + spinner + error states
```

**Modified files**
```
src/lib/codex-editor/types.ts                   # + attachments?, selectedAudioId? on CodexCellMetadata
src/components/EditorTable.tsx                  # render <CellAudioButton> in each row
```

---

## Task 1: Pointer parser + type additions

**Files:**
- Create: `src/lib/lfs/pointer.ts`
- Create: `src/lib/lfs/__test__/pointer.test.ts`
- Modify: `src/lib/codex-editor/types.ts`

### Step 1.1 — Extend `CodexCellMetadata`

Edit `src/lib/codex-editor/types.ts` — find `export interface CodexCellMetadata` (around line 51) and add the two optional fields before the closing brace:

```ts
export interface CodexCellAttachment {
  url: string
  type: string
  createdAt?: number
  updatedAt?: number
  isDeleted?: boolean
  isMissing?: boolean
}

export interface CodexCellMetadata {
  id: string;
  type: CodexCellType;
  edits?: EditHistory[];
  data?: CodexData;
  cellLabel?: string;
  parentId?: string;
  isLocked?: boolean;
  attachments?: Record<string, CodexCellAttachment>;
  selectedAudioId?: string;
}
```

- [ ] **Step 1.2 — Write the failing test**

Create `src/lib/lfs/__test__/pointer.test.ts`:

```ts
import { describe, it, expect } from "vitest"
import { parsePointerContent, isLfsPointerContent } from "../pointer"

const VALID = `version https://git-lfs.github.com/spec/v1
oid sha256:1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef
size 45812
`

describe("parsePointerContent", () => {
  it("parses a valid pointer", () => {
    expect(parsePointerContent(VALID)).toEqual({
      oid: "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
      size: 45812,
      version: "https://git-lfs.github.com/spec/v1",
    })
  })

  it("returns null for missing version", () => {
    expect(parsePointerContent("oid sha256:abc\nsize 1\n")).toBeNull()
  })

  it("returns null for missing oid", () => {
    expect(parsePointerContent("version https://git-lfs.github.com/spec/v1\nsize 1\n")).toBeNull()
  })

  it("returns null for missing size", () => {
    expect(parsePointerContent(
      "version https://git-lfs.github.com/spec/v1\noid sha256:abc\n"
    )).toBeNull()
  })

  it("returns null for short-hash oid (not 64 chars)", () => {
    expect(parsePointerContent(
      "version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 1\n"
    )).toBeNull()
  })
})

describe("isLfsPointerContent", () => {
  it("recognizes a pointer as bytes", () => {
    const bytes = new TextEncoder().encode(VALID)
    expect(isLfsPointerContent(bytes)).toBe(true)
  })

  it("rejects bytes over 400 length as non-pointer (cheap guard)", () => {
    const big = new Uint8Array(500)
    expect(isLfsPointerContent(big)).toBe(false)
  })

  it("rejects small bytes lacking the LFS signature", () => {
    const bytes = new TextEncoder().encode("hello world")
    expect(isLfsPointerContent(bytes)).toBe(false)
  })
})
```

- [ ] **Step 1.3 — Verify tests fail**

```bash
npx vitest run src/lib/lfs/__test__/pointer.test.ts
```
Expected: module-not-found errors.

- [ ] **Step 1.4 — Implement `pointer.ts`**

Create `src/lib/lfs/pointer.ts`:

```ts
// src/lib/lfs/pointer.ts
// Port of codex-editor/src/utils/lfsHelpers.ts:68-97. Pure functions, no I/O.

export interface LfsPointer {
  oid: string
  size: number
  version: string
}

export function parsePointerContent(content: string): LfsPointer | null {
  const versionMatch = content.match(/version (https:\/\/git-lfs\.github\.com\/spec\/v\d+)/)
  if (!versionMatch) return null

  const oidMatch = content.match(/oid sha256:([a-f0-9]{64})/i)
  if (!oidMatch) return null

  const sizeMatch = content.match(/size (\d+)/)
  if (!sizeMatch) return null

  const size = Number.parseInt(sizeMatch[1], 10)
  if (!Number.isFinite(size)) return null

  return {
    version: versionMatch[1],
    oid: oidMatch[1].toLowerCase(),
    size,
  }
}

export function isLfsPointerContent(data: Uint8Array): boolean {
  // Cheap length guard: real LFS pointers are ≤ ~150 bytes, we use 400 as a
  // generous cutoff before we even attempt to decode.
  if (data.length > 400) return false
  const text = new TextDecoder("utf-8", { fatal: false }).decode(data)
  return text.includes("version https://git-lfs.github.com/spec/v1")
}
```

- [ ] **Step 1.5 — Run tests + typecheck**

```bash
npx vitest run src/lib/lfs/__test__/pointer.test.ts
npx tsc -b
```
Expected: 8 pointer tests pass; tsc clean.

- [ ] **Step 1.6 — Commit**

```bash
git add src/lib/codex-editor/types.ts \
        src/lib/lfs/pointer.ts \
        src/lib/lfs/__test__/pointer.test.ts
git commit -m "feat(audio): LFS pointer parser + attachment/selectedAudioId types"
```

---

## Task 2: OPFS blob cache

**Files:**
- Create: `src/lib/lfs/cache.ts`
- Create: `src/lib/lfs/__test__/cache.test.ts`

The cache lives at `/lfs-cache/<first2>/<oid>` at the OPFS root (not inside any repo dir). We'll use the existing `createOpfsFs` wrapper over the root handle.

- [ ] **Step 2.1 — Write the failing test**

Create `src/lib/lfs/__test__/cache.test.ts`:

```ts
import "fake-indexeddb/auto"
import { describe, it, expect, beforeEach, vi } from "vitest"
import { createOpfsFs } from "@/lib/git/opfs-fs"
import { MemoryDirectoryHandle } from "@/lib/git/__test__/mem-fs-handles"
import * as cache from "../cache"

// Helper: compute SHA-256 hex string
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", bytes as BufferSource)
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("")
}

describe("lfsCache", () => {
  let root: MemoryDirectoryHandle

  beforeEach(() => {
    root = new MemoryDirectoryHandle("root")
    // Inject a mock OPFS root so cache.ts doesn't try navigator.storage.getDirectory()
    cache.__setRootForTests(createOpfsFs(root as unknown as FileSystemDirectoryHandle))
  })

  it("returns null on cache miss", async () => {
    const out = await cache.lfsCacheGet("a".repeat(64))
    expect(out).toBeNull()
  })

  it("writes and reads bytes verbatim", async () => {
    const bytes = new TextEncoder().encode("hello audio")
    const oid = await sha256Hex(bytes)
    await cache.lfsCachePut(oid, bytes)
    const got = await cache.lfsCacheGet(oid)
    expect(got).toBeInstanceOf(Uint8Array)
    expect(new TextDecoder().decode(got!)).toBe("hello audio")
  })

  it("rejects put when sha256 doesn't match oid", async () => {
    const bytes = new TextEncoder().encode("not the right bytes")
    const wrongOid = "b".repeat(64)
    await expect(cache.lfsCachePut(wrongOid, bytes)).rejects.toThrow(/integrity/i)
    const got = await cache.lfsCacheGet(wrongOid)
    expect(got).toBeNull()  // nothing was written
  })

  it("shards storage by first two hex characters of the oid", async () => {
    const bytes = new TextEncoder().encode("x")
    const oid = await sha256Hex(bytes)
    await cache.lfsCachePut(oid, bytes)

    // First 2 chars of sha256("x") → inspect the dir layout
    const first2 = oid.slice(0, 2)
    const lfsDir = await root.getDirectoryHandle("lfs-cache")
    const shard = await lfsDir.getDirectoryHandle(first2)
    const file = await shard.getFileHandle(oid)
    expect(file).toBeDefined()
  })
})
```

- [ ] **Step 2.2 — Verify it fails**

```bash
npx vitest run src/lib/lfs/__test__/cache.test.ts
```
Expected: module-not-found.

- [ ] **Step 2.3 — Implement `cache.ts`**

Create `src/lib/lfs/cache.ts`:

```ts
// src/lib/lfs/cache.ts
// OPFS-backed blob cache keyed on LFS oid. Lives at /lfs-cache/<first2>/<oid>
// — separate from repo dirs so it survives re-imports and isn't part of any
// git working tree. Shards on the first 2 hex chars so single directories stay
// small.

import { createOpfsFs, type OpfsFs } from "@/lib/git/opfs-fs"

let rootFsCache: OpfsFs | null = null

async function rootFs(): Promise<OpfsFs> {
  if (rootFsCache) return rootFsCache
  const handle = await navigator.storage.getDirectory()
  rootFsCache = createOpfsFs(handle)
  return rootFsCache
}

/** Test seam — inject a memory-backed fs instead of navigator.storage. */
export function __setRootForTests(fs: OpfsFs): void {
  rootFsCache = fs
}

function cachePath(oid: string): string {
  return `/lfs-cache/${oid.slice(0, 2)}/${oid}`
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", bytes as BufferSource)
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("")
}

export async function lfsCacheGet(oid: string): Promise<Uint8Array | null> {
  const fs = await rootFs()
  try {
    const bytes = await fs.promises.readFile(cachePath(oid))
    return typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes
  } catch {
    return null
  }
}

export async function lfsCachePut(oid: string, bytes: Uint8Array): Promise<void> {
  const actual = await sha256Hex(bytes)
  if (actual !== oid.toLowerCase()) {
    throw new Error(
      `LFS cache integrity mismatch: expected oid ${oid.slice(0, 12)}..., got ${actual.slice(0, 12)}...`,
    )
  }
  const fs = await rootFs()
  await fs.promises.writeFile(cachePath(oid), bytes)
}
```

- [ ] **Step 2.4 — Run tests + typecheck**

```bash
npx vitest run src/lib/lfs/__test__/cache.test.ts
npx tsc -b
```
Expected: 4 cache tests pass; tsc clean.

- [ ] **Step 2.5 — Commit**

```bash
git add src/lib/lfs/cache.ts src/lib/lfs/__test__/cache.test.ts
git commit -m "feat(audio): OPFS blob cache with sha256 integrity check"
```

---

## Task 3: LFS download client

**Files:**
- Create: `src/lib/lfs/download.ts`
- Create: `src/lib/lfs/__test__/download.test.ts`

- [ ] **Step 3.1 — Write the failing test**

Create `src/lib/lfs/__test__/download.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest"
import { downloadLfsBlob } from "../download"

const CLONE_URL = "https://git.genesisrnd.com/group/repo.git"
const TOKEN = "glpat-test"

// Helper: compute sha256 of bytes (same impl as cache.ts)
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", bytes as BufferSource)
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("")
}

describe("downloadLfsBlob", () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock)
    fetchMock.mockReset()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("posts the batch request and GETs the returned href", async () => {
    const bytes = new TextEncoder().encode("abcdef")
    const oid = await sha256Hex(bytes)
    const size = bytes.byteLength

    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        objects: [{ oid, size, actions: { download: {
          href: "https://r2.cloudflarestorage.com/lfs/obj?sig=xyz",
          header: { "X-Custom": "1" },
        } } }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(bytes.buffer as ArrayBuffer, { status: 200 }))

    const got = await downloadLfsBlob({ cloneUrl: CLONE_URL, gitlabToken: TOKEN, oid, size })
    expect(got).toBeInstanceOf(Uint8Array)
    expect(new TextDecoder().decode(got)).toBe("abcdef")

    // Batch call
    const [batchUrl, batchInit] = fetchMock.mock.calls[0]
    expect(batchUrl).toContain("/info/lfs/objects/batch")
    expect((batchInit as RequestInit).method).toBe("POST")
    const batchBody = JSON.parse((batchInit as RequestInit).body as string)
    expect(batchBody).toMatchObject({ operation: "download", objects: [{ oid, size }] })

    // GET call
    const [getUrl, getInit] = fetchMock.mock.calls[1]
    expect(getUrl).toContain("r2.cloudflarestorage.com")
    expect((getInit as RequestInit).method).toBe("GET")
    expect((getInit as RequestInit).headers).toMatchObject({ "X-Custom": "1" })
  })

  it("throws batch-failed if the batch response has an error object", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      objects: [{ oid: "x", size: 1, error: { code: 404, message: "not found" } }],
    }), { status: 200 }))

    await expect(
      downloadLfsBlob({ cloneUrl: CLONE_URL, gitlabToken: TOKEN, oid: "x", size: 1 }),
    ).rejects.toMatchObject({ kind: "batch-failed" })
  })

  it("throws batch-failed on non-2xx batch response", async () => {
    fetchMock.mockResolvedValueOnce(new Response("unauthorized", { status: 401 }))
    await expect(
      downloadLfsBlob({ cloneUrl: CLONE_URL, gitlabToken: TOKEN, oid: "x", size: 1 }),
    ).rejects.toMatchObject({ kind: "batch-failed" })
  })

  it("throws download-failed on sha256 mismatch", async () => {
    const realBytes = new TextEncoder().encode("expected payload")
    const expectedOid = await sha256Hex(realBytes)
    // But the server returns different bytes
    const wrongBytes = new TextEncoder().encode("wrong payload")

    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        objects: [{ oid: expectedOid, size: realBytes.byteLength,
                    actions: { download: { href: "https://r2/obj" } } }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(wrongBytes.buffer as ArrayBuffer, { status: 200 }))

    await expect(
      downloadLfsBlob({ cloneUrl: CLONE_URL, gitlabToken: TOKEN, oid: expectedOid, size: realBytes.byteLength }),
    ).rejects.toMatchObject({ kind: "download-failed" })
  })

  it("throws download-failed on non-2xx blob GET", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        objects: [{ oid: "x", size: 1, actions: { download: { href: "https://r2/obj" } } }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response("oops", { status: 500 }))

    await expect(
      downloadLfsBlob({ cloneUrl: CLONE_URL, gitlabToken: TOKEN, oid: "x", size: 1 }),
    ).rejects.toMatchObject({ kind: "download-failed" })
  })
})
```

- [ ] **Step 3.2 — Verify it fails**

```bash
npx vitest run src/lib/lfs/__test__/download.test.ts
```
Expected: module-not-found.

- [ ] **Step 3.3 — Implement `download.ts`**

Create `src/lib/lfs/download.ts`:

```ts
// src/lib/lfs/download.ts
// Two-call LFS download flow, routed through the existing GIT_CORS_PROXY.
// Ported from frontier-authentication/src/git/GitService.ts:648-728.

import { GIT_CORS_PROXY } from "@/lib/git/clone"

export interface DownloadArgs {
  cloneUrl: string      // e.g. https://git.genesisrnd.com/group/repo.git
  gitlabToken: string
  oid: string           // 64-hex sha256
  size: number
  signal?: AbortSignal
}

export type LfsDownloadError =
  | { kind: "batch-failed"; message: string }
  | { kind: "download-failed"; message: string }

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", bytes as BufferSource)
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("")
}

function proxied(url: string): string {
  // codex-git-proxy forwards {proxy}/<rawUrl> to <rawUrl> and adds CORS.
  // Strip the scheme since the worker expects hostname-first paths.
  const stripped = url.replace(/^https?:\/\//, "")
  return `${GIT_CORS_PROXY}/${stripped}`
}

export async function downloadLfsBlob({
  cloneUrl, gitlabToken, oid, size, signal,
}: DownloadArgs): Promise<Uint8Array> {
  const authHeader = `Basic ${btoa(`oauth2:${gitlabToken}`)}`
  const batchUrl = `${cloneUrl}/info/lfs/objects/batch`

  // 1) Batch request.
  let batchResp: Response
  try {
    batchResp = await fetch(proxied(batchUrl), {
      method: "POST",
      signal,
      headers: {
        Authorization: authHeader,
        Accept: "application/vnd.git-lfs+json",
        "Content-Type": "application/vnd.git-lfs+json",
      },
      body: JSON.stringify({
        operation: "download",
        transfers: ["basic"],
        objects: [{ oid, size }],
      }),
    })
  } catch (e) {
    const err: LfsDownloadError = {
      kind: "batch-failed",
      message: e instanceof Error ? e.message : String(e),
    }
    throw err
  }

  if (!batchResp.ok) {
    const err: LfsDownloadError = {
      kind: "batch-failed",
      message: `LFS batch HTTP ${batchResp.status}`,
    }
    throw err
  }

  let batchJson: { objects?: Array<{
    actions?: { download?: { href: string; header?: Record<string, string> } }
    error?: { code: number; message: string }
  }> }
  try {
    batchJson = await batchResp.json()
  } catch (e) {
    const err: LfsDownloadError = {
      kind: "batch-failed",
      message: `LFS batch returned non-JSON: ${e instanceof Error ? e.message : String(e)}`,
    }
    throw err
  }

  const obj = batchJson.objects?.[0]
  if (!obj) {
    const err: LfsDownloadError = { kind: "batch-failed", message: "LFS batch returned no objects" }
    throw err
  }
  if (obj.error) {
    const err: LfsDownloadError = {
      kind: "batch-failed",
      message: `LFS server: ${obj.error.code} ${obj.error.message}`,
    }
    throw err
  }
  if (!obj.actions?.download?.href) {
    const err: LfsDownloadError = { kind: "batch-failed", message: "LFS batch missing download action" }
    throw err
  }

  // 2) Fetch the blob.
  const { href, header = {} } = obj.actions.download
  let blobResp: Response
  try {
    blobResp = await fetch(proxied(href), {
      method: "GET",
      signal,
      headers: header,
    })
  } catch (e) {
    const err: LfsDownloadError = {
      kind: "download-failed",
      message: e instanceof Error ? e.message : String(e),
    }
    throw err
  }
  if (!blobResp.ok) {
    const err: LfsDownloadError = {
      kind: "download-failed",
      message: `LFS blob HTTP ${blobResp.status}`,
    }
    throw err
  }

  const bytes = new Uint8Array(await blobResp.arrayBuffer())

  // 3) Integrity check.
  const actualOid = await sha256Hex(bytes)
  if (actualOid !== oid.toLowerCase()) {
    const err: LfsDownloadError = {
      kind: "download-failed",
      message: `sha256 mismatch: expected ${oid.slice(0, 12)}..., got ${actualOid.slice(0, 12)}...`,
    }
    throw err
  }

  return bytes
}
```

- [ ] **Step 3.4 — Run tests + typecheck**

```bash
npx vitest run src/lib/lfs/__test__/download.test.ts
npx tsc -b
```
Expected: 5 download tests pass; tsc clean.

- [ ] **Step 3.5 — Commit**

```bash
git add src/lib/lfs/download.ts src/lib/lfs/__test__/download.test.ts
git commit -m "feat(audio): LFS download client (batch + GET + sha256 verify)"
```

---

## Task 4: `useCellAudio` hook

**Files:**
- Create: `src/hooks/useCellAudio.ts`
- Create: `src/hooks/useCellAudio.test.tsx`

The hook composes pointer parsing, cache, and download. It owns the `HTMLAudioElement` and the object URL so the button component stays a dumb render.

- [ ] **Step 4.1 — Write the failing test**

Create `src/hooks/useCellAudio.test.tsx`:

```tsx
import "fake-indexeddb/auto"
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest"
import { renderHook, act } from "@testing-library/react"
import { createOpfsFs } from "@/lib/git/opfs-fs"
import { MemoryDirectoryHandle } from "@/lib/git/__test__/mem-fs-handles"
import { useCellAudio } from "./useCellAudio"
import * as cache from "@/lib/lfs/cache"
import type { CodexCell } from "@/lib/codex-editor/types"
import type { ProjectRecord } from "@/lib/parsers/types"

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", bytes as BufferSource)
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("")
}

const session = { gitlabToken: "tok", username: "u" }

// Mock the session hook so useCellAudio can read it
vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session }),
}))

// Mock openOpfsRepoDir + the Audio constructor
const fakeRepoRoot = new MemoryDirectoryHandle("repo")
vi.mock("@/lib/git/opfs-fs", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/git/opfs-fs")>()
  return {
    ...actual,
    openOpfsRepoDir: vi.fn(async () => fakeRepoRoot as unknown as FileSystemDirectoryHandle),
  }
})

// URL.createObjectURL / revokeObjectURL aren't implemented in happy-dom — stub them.
let nextUrlId = 0
const createdUrls: string[] = []
const revokedUrls: string[] = []
beforeEach(() => {
  // Reset tracking
  nextUrlId = 0
  createdUrls.length = 0
  revokedUrls.length = 0
  // Stub URL factories
  Object.defineProperty(globalThis.URL, "createObjectURL", {
    writable: true,
    value: vi.fn((_blob: Blob) => {
      const u = `blob:mock-${++nextUrlId}`
      createdUrls.push(u)
      return u
    }),
  })
  Object.defineProperty(globalThis.URL, "revokeObjectURL", {
    writable: true,
    value: vi.fn((u: string) => { revokedUrls.push(u) }),
  })
  // Stub Audio so it doesn't actually try to play
  Object.defineProperty(globalThis, "Audio", {
    writable: true,
    value: class {
      src: string = ""
      public onplay: (() => void) | null = null
      public onpause: (() => void) | null = null
      public onended: (() => void) | null = null
      constructor(src?: string) { if (src) this.src = src }
      async play() { this.onplay?.() }
      pause() { this.onpause?.() }
    },
  })
  // Inject memory fs into cache module
  cache.__setRootForTests(createOpfsFs(new MemoryDirectoryHandle("root") as unknown as FileSystemDirectoryHandle))
})
afterEach(() => { vi.restoreAllMocks() })

async function seedPointerInRepo(urlRelative: string, oid: string, size: number): Promise<void> {
  const repoFs = createOpfsFs(fakeRepoRoot as unknown as FileSystemDirectoryHandle)
  const text = `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${size}\n`
  await repoFs.promises.writeFile(urlRelative, text)
}

function makeProject(): ProjectRecord {
  return {
    id: "p1", name: "P", sourceLanguage: "en", targetLanguage: "es",
    createdAt: "", files: [], members: [],
    origin: { kind: "git", cloneUrl: "https://git.genesisrnd.com/g/r.git",
              gitlabProjectId: 1, branch: "main", headSha: "abc",
              importedAt: "" },
  } as unknown as ProjectRecord
}

function makeCell(selectedAudioId: string, attachmentUrl: string): CodexCell {
  return {
    kind: 2, languageId: "html", value: "",
    metadata: {
      id: "cell-1", type: "text",
      attachments: { [selectedAudioId]: { url: attachmentUrl, type: "audio" } },
      selectedAudioId,
    },
  } as unknown as CodexCell
}

describe("useCellAudio", () => {
  const fetchMock = vi.fn()
  beforeEach(() => { vi.stubGlobal("fetch", fetchMock); fetchMock.mockReset() })

  it("happy path: loads pointer, downloads, plays", async () => {
    const bytes = new TextEncoder().encode("audio-bytes")
    const oid = await sha256Hex(bytes)
    const size = bytes.byteLength
    await seedPointerInRepo("/.project/attachments/files/JUD/a.webm", oid, size)

    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        objects: [{ oid, size, actions: { download: { href: "https://r2/o" } } }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(bytes.buffer as ArrayBuffer, { status: 200 }))

    const project = makeProject()
    const cell = makeCell("a1", "/.project/attachments/files/JUD/a.webm")
    const { result } = renderHook(() => useCellAudio(project, cell))

    expect(result.current.state).toBe("idle")

    await act(async () => { await result.current.play() })

    expect(result.current.state).toBe("ready")
    expect(result.current.error).toBeNull()
    expect(createdUrls.length).toBe(1)
  })

  it("surfaces pointer-missing when the file isn't in the repo", async () => {
    const project = makeProject()
    const cell = makeCell("a1", "/.project/attachments/files/JUD/nope.webm")
    const { result } = renderHook(() => useCellAudio(project, cell))

    await act(async () => { await result.current.play() })
    expect(result.current.state).toBe("error")
    expect(result.current.error).toMatchObject({ kind: "pointer-missing" })
  })

  it("surfaces pointer-invalid when the file isn't a pointer", async () => {
    const repoFs = createOpfsFs(fakeRepoRoot as unknown as FileSystemDirectoryHandle)
    await repoFs.promises.writeFile("/.project/attachments/files/JUD/weird.webm", "not a pointer")

    const project = makeProject()
    const cell = makeCell("a1", "/.project/attachments/files/JUD/weird.webm")
    const { result } = renderHook(() => useCellAudio(project, cell))

    await act(async () => { await result.current.play() })
    expect(result.current.state).toBe("error")
    expect(result.current.error).toMatchObject({ kind: "pointer-invalid" })
  })

  it("uses the cache on replay (no fetch second time)", async () => {
    const bytes = new TextEncoder().encode("cached-audio")
    const oid = await sha256Hex(bytes)
    const size = bytes.byteLength
    await seedPointerInRepo("/.project/attachments/files/JUD/c.webm", oid, size)

    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        objects: [{ oid, size, actions: { download: { href: "https://r2/o" } } }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(bytes.buffer as ArrayBuffer, { status: 200 }))

    const project = makeProject()
    const cell = makeCell("a1", "/.project/attachments/files/JUD/c.webm")
    const { result } = renderHook(() => useCellAudio(project, cell))

    await act(async () => { await result.current.play() })
    expect(fetchMock.mock.calls.length).toBe(2)

    // Unmount + remount (simulate scroll-off / scroll-back)
    const { result: result2 } = renderHook(() => useCellAudio(project, cell))
    await act(async () => { await result2.current.play() })
    // Still 2 — cache served it, no new HTTP.
    expect(fetchMock.mock.calls.length).toBe(2)
  })

  it("revokes the object URL on unmount", async () => {
    const bytes = new TextEncoder().encode("revoke-test")
    const oid = await sha256Hex(bytes)
    const size = bytes.byteLength
    await seedPointerInRepo("/.project/attachments/files/JUD/r.webm", oid, size)

    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        objects: [{ oid, size, actions: { download: { href: "https://r2/o" } } }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(bytes.buffer as ArrayBuffer, { status: 200 }))

    const project = makeProject()
    const cell = makeCell("a1", "/.project/attachments/files/JUD/r.webm")
    const { result, unmount } = renderHook(() => useCellAudio(project, cell))
    await act(async () => { await result.current.play() })
    expect(createdUrls.length).toBe(1)

    unmount()
    expect(revokedUrls).toContain(createdUrls[0])
  })
})
```

- [ ] **Step 4.2 — Verify it fails**

```bash
npx vitest run src/hooks/useCellAudio.test.tsx
```
Expected: module-not-found.

- [ ] **Step 4.3 — Implement `useCellAudio.ts`**

Create `src/hooks/useCellAudio.ts`:

```ts
// src/hooks/useCellAudio.ts
// React hook that loads per-cell LFS audio on demand. Owns the
// HTMLAudioElement lifecycle and revokes the object URL on unmount /
// selectedAudioId change.

import { useCallback, useEffect, useRef, useState } from "react"
import { createOpfsFs, openOpfsRepoDir } from "@/lib/git/opfs-fs"
import { opfsRepoKey, pathWithNamespaceFromCloneUrl } from "@/lib/git/repo-key"
import { parsePointerContent } from "@/lib/lfs/pointer"
import { lfsCacheGet, lfsCachePut } from "@/lib/lfs/cache"
import { downloadLfsBlob } from "@/lib/lfs/download"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import type { CodexCell } from "@/lib/codex-editor/types"
import type { ProjectRecord } from "@/lib/parsers/types"

export type AudioErrorKind =
  | "pointer-missing"
  | "pointer-invalid"
  | "batch-failed"
  | "download-failed"
  | "no-session"
  | "no-git-origin"

export interface AudioError {
  kind: AudioErrorKind
  message: string
}

export interface UseCellAudioResult {
  state: "idle" | "loading" | "ready" | "error"
  error: AudioError | null
  isPlaying: boolean
  play: () => Promise<void>
  pause: () => void
}

export function useCellAudio(
  project: ProjectRecord,
  cell: CodexCell,
): UseCellAudioResult {
  const { session } = useFrontierSession()
  const [state, setState] = useState<UseCellAudioResult["state"]>("idle")
  const [error, setError] = useState<AudioError | null>(null)
  const [isPlaying, setIsPlaying] = useState(false)

  const audioRef = useRef<HTMLAudioElement | null>(null)
  const urlRef = useRef<string | null>(null)

  const selectedAudioId = cell.metadata?.selectedAudioId
  const attachment = selectedAudioId
    ? cell.metadata?.attachments?.[selectedAudioId]
    : undefined
  const attachmentUrl = attachment?.url

  // Reset on selection change or unmount: revoke URL, tear down audio.
  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause()
        audioRef.current = null
      }
      if (urlRef.current) {
        URL.revokeObjectURL(urlRef.current)
        urlRef.current = null
      }
      setState("idle")
      setIsPlaying(false)
      setError(null)
    }
  }, [selectedAudioId])

  const load = useCallback(async (): Promise<Uint8Array> => {
    if (!attachmentUrl) {
      throw { kind: "pointer-missing", message: "No audio attachment on this cell" } as AudioError
    }
    if (project.origin?.kind !== "git") {
      throw { kind: "no-git-origin", message: "Project has no git origin" } as AudioError
    }
    if (!session?.gitlabToken) {
      throw { kind: "no-session", message: "Not signed in" } as AudioError
    }

    // 1) Read pointer from the repo OPFS.
    const repoHandle = await openOpfsRepoDir(
      opfsRepoKey(
        project.origin.gitlabProjectId,
        pathWithNamespaceFromCloneUrl(project.origin.cloneUrl),
      ),
    )
    const repoFs = createOpfsFs(repoHandle)
    let pointerText: string
    try {
      const data = await repoFs.promises.readFile(attachmentUrl, { encoding: "utf8" })
      pointerText = typeof data === "string" ? data : new TextDecoder().decode(data)
    } catch (e) {
      throw {
        kind: "pointer-missing",
        message: `Could not read ${attachmentUrl}: ${e instanceof Error ? e.message : String(e)}`,
      } as AudioError
    }

    const pointer = parsePointerContent(pointerText)
    if (!pointer) {
      throw { kind: "pointer-invalid", message: `${attachmentUrl} is not a valid LFS pointer` } as AudioError
    }

    // 2) Cache hit?
    const cached = await lfsCacheGet(pointer.oid)
    if (cached) return cached

    // 3) Download + cache.
    try {
      const bytes = await downloadLfsBlob({
        cloneUrl: project.origin.cloneUrl,
        gitlabToken: session.gitlabToken,
        oid: pointer.oid,
        size: pointer.size,
      })
      try { await lfsCachePut(pointer.oid, bytes) } catch { /* cache-write failure is non-fatal */ }
      return bytes
    } catch (e) {
      // downloadLfsBlob throws { kind, message } — propagate as-is.
      if (e && typeof e === "object" && "kind" in e) throw e as AudioError
      throw { kind: "download-failed", message: e instanceof Error ? e.message : String(e) } as AudioError
    }
  }, [attachmentUrl, project, session])

  const play = useCallback(async () => {
    // Already loaded — just resume.
    if (audioRef.current) {
      try { await audioRef.current.play() } catch (e) {
        console.error("[useCellAudio] play() rejected", e)
      }
      return
    }
    setState("loading")
    setError(null)
    try {
      const bytes = await load()
      const blob = new Blob([bytes as BlobPart])
      const url = URL.createObjectURL(blob)
      urlRef.current = url
      const audio = new Audio(url)
      audio.onplay = () => setIsPlaying(true)
      audio.onpause = () => setIsPlaying(false)
      audio.onended = () => setIsPlaying(false)
      audioRef.current = audio
      setState("ready")
      try {
        await audio.play()
      } catch (e) {
        console.error("[useCellAudio] play() rejected on fresh audio", e)
      }
    } catch (e) {
      const err = (e && typeof e === "object" && "kind" in e)
        ? (e as AudioError)
        : { kind: "download-failed" as const, message: String(e) }
      console.error("[useCellAudio]", err)
      setError(err)
      setState("error")
    }
  }, [load])

  const pause = useCallback(() => {
    audioRef.current?.pause()
  }, [])

  return { state, error, isPlaying, play, pause }
}
```

- [ ] **Step 4.4 — Run tests + typecheck**

```bash
npx vitest run src/hooks/useCellAudio.test.tsx
npx tsc -b
```
Expected: 5 hook tests pass; tsc clean.

- [ ] **Step 4.5 — Commit**

```bash
git add src/hooks/useCellAudio.ts src/hooks/useCellAudio.test.tsx
git commit -m "feat(audio): useCellAudio hook — load, cache, play"
```

---

## Task 5: `CellAudioButton` component

**Files:**
- Create: `src/components/CellAudioButton.tsx`

The button is a thin render over `useCellAudio`. No new tests — it has no logic beyond state-to-icon mapping; we'll verify rendering manually in Task 6.

- [ ] **Step 5.1 — Implement the component**

Create `src/components/CellAudioButton.tsx`:

```tsx
// src/components/CellAudioButton.tsx
// Compact ▶/⏸ button rendered in the cell row when selectedAudioId is set
// and the attachment isn't marked deleted.

import { AlertCircle, Loader2, Pause, Play } from "lucide-react"
import { cn } from "@/lib/utils"
import { useCellAudio } from "@/hooks/useCellAudio"
import type { CodexCell } from "@/lib/codex-editor/types"
import type { ProjectRecord } from "@/lib/parsers/types"

interface Props {
  project: ProjectRecord
  cell: CodexCell
}

export function CellAudioButton({ project, cell }: Props) {
  const selectedAudioId = cell.metadata?.selectedAudioId
  const attachment = selectedAudioId
    ? cell.metadata?.attachments?.[selectedAudioId]
    : undefined

  // Never render for deleted attachments or missing config.
  if (!attachment || attachment.isDeleted === true) return null

  const { state, error, isPlaying, play, pause } = useCellAudio(project, cell)

  const onClick = () => {
    if (state === "loading") return
    if (isPlaying) { pause(); return }
    void play()  // also retries from the error state — fresh play() will reattempt the load
  }

  const tooltip =
    state === "error" && error
      ? errorTooltip(error.kind)
      : isPlaying
        ? "Pause audio"
        : "Play audio"

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={state === "loading"}
      title={tooltip}
      className={cn(
        "mt-1 flex h-5 w-5 items-center justify-center rounded",
        state === "error"
          ? "text-destructive hover:text-destructive/80"
          : "text-muted-foreground/60 hover:text-muted-foreground",
      )}
    >
      {state === "loading" && <Loader2 className="h-3 w-3 animate-spin" />}
      {state === "error" && <AlertCircle className="h-3 w-3" />}
      {state !== "loading" && state !== "error" && (isPlaying
        ? <Pause className="h-3 w-3" />
        : <Play className="h-3 w-3" />
      )}
    </button>
  )
}

function errorTooltip(kind: string): string {
  switch (kind) {
    case "pointer-missing": return "Audio not available — sync the project"
    case "pointer-invalid": return "Audio format unrecognized"
    case "batch-failed": return "Couldn't reach audio server"
    case "download-failed": return "Audio download corrupted — try again"
    case "no-session": return "Sign in to play audio"
    case "no-git-origin": return "This project isn't connected to git"
    default: return "Audio error"
  }
}
```

- [ ] **Step 5.2 — Typecheck**

```bash
npx tsc -b
```
Expected: clean.

- [ ] **Step 5.3 — Commit**

```bash
git add src/components/CellAudioButton.tsx
git commit -m "feat(audio): CellAudioButton — compact play/pause control"
```

---

## Task 6: Wire into `EditorTable` + manual verification + deploy

**Files:**
- Modify: `src/components/EditorTable.tsx`

- [ ] **Step 6.1 — Pass `project` into `EditorRow`**

`EditorRow` doesn't currently receive the `project` prop. `CellAudioButton` needs it. Look for `interface EditorRowProps` in `src/components/EditorTable.tsx` (around line 171) and add:

```ts
interface EditorRowProps {
  // ... existing fields ...
  project: ProjectRecord
}
```

Add the import at the top of the file if not already present:

```ts
import type { ProjectRecord } from "@/lib/parsers/types"
```

- [ ] **Step 6.2 — Pass `project` from the table into each row**

Find the `<EditorRow` JSX (around line 129). Add `project={project}` to the props passed — the table already has access to `project` via its own props.

- [ ] **Step 6.3 — Render the button next to the validation icon**

Find the right-hand-side column block (around line 462) that currently renders `{validationIcon}` and the comments button. Import `CellAudioButton` at the top:

```ts
import { CellAudioButton } from "./CellAudioButton"
```

And render it directly after `{validationIcon}`:

```tsx
<div className="flex flex-col items-center">
  {validationIcon}
  <CellAudioButton project={project} cell={cellForButton} />
  {onOpenComments && (
    {/* ... existing comments button ... */}
  )}
</div>
```

`cellForButton` needs to be a `CodexCell` (not the `CellData` that the row currently works with). The `CellData` already has `id` and `metadata` we need, but for Phase 1 safety, reconstruct a minimal `CodexCell` shape:

```ts
// Inside EditorRow, before the return:
const cellForButton = {
  kind: 2 as const,
  languageId: "html",
  value: cell.translated ?? "",
  metadata: {
    id: cell.id,
    type: (cell.type ?? "text") as "text",
    attachments: (cell as unknown as { attachments?: Record<string, { url: string; type: string; isDeleted?: boolean }> }).attachments,
    selectedAudioId: (cell as unknown as { selectedAudioId?: string }).selectedAudioId,
  },
} as unknown as import("@/lib/codex-editor/types").CodexCell
```

This is defensive because `CellData` (from `useCells.ts`) was shaped for the editor UI and doesn't expose `attachments` / `selectedAudioId`. We'll surface those in a follow-up so the cast goes away.

- [ ] **Step 6.4 — Surface `attachments` + `selectedAudioId` on `CellData`**

Edit `src/hooks/useCells.ts` — find `export interface CellData` and add:

```ts
attachments?: Record<string, import("@/lib/codex-editor/types").CodexCellAttachment>
selectedAudioId?: string
```

Find `computeOrdered()` in the same file and populate those fields from the Y.Map's `__source`:

```ts
const source = cell.get("__source") as
  | { metadata?: { attachments?: Record<string, unknown>; selectedAudioId?: string } }
  | undefined
// ... inside the push():
attachments: source?.metadata?.attachments as CellData["attachments"],
selectedAudioId: source?.metadata?.selectedAudioId,
```

Now replace the defensive cast in `EditorRow` with a cleaner construction:

```tsx
const cellForButton = {
  kind: 2 as const,
  languageId: "html",
  value: cell.translated ?? "",
  metadata: {
    id: cell.id,
    type: (cell.type ?? "text") as "text",
    attachments: cell.attachments,
    selectedAudioId: cell.selectedAudioId,
  },
} as unknown as import("@/lib/codex-editor/types").CodexCell
```

- [ ] **Step 6.5 — Run the full test suite + typecheck**

```bash
npx vitest run
npx tsc -b
```
Expected: all existing tests still green; tsc clean.

- [ ] **Step 6.6 — Commit**

```bash
git add src/components/EditorTable.tsx src/hooks/useCells.ts
git commit -m "feat(audio): wire CellAudioButton into EditorTable"
```

- [ ] **Step 6.7 — Manual browser verification**

```bash
npm run dev
```

Open a git project that has audio attachments. In the DevTools Network tab:
1. First play on a cell shows exactly one `POST .../info/lfs/objects/batch` and one `GET` against the returned href. Audio plays.
2. Click pause; icon switches to ▶. Click play again; no new network traffic.
3. Scroll away, scroll back, click play: no new network (cache hit).
4. Refresh the page, click play on the same cell: no new network (OPFS cache persists).
5. Intentional failure test: disconnect WiFi, open a cell whose audio isn't cached. Button shows error icon; tooltip says "Couldn't reach audio server"; click retries. Reconnect, retry succeeds.

If the R2 `download.href` throws CORS in the browser (uncached, direct fetch rejected), the existing proxy path should already cover it since `download.ts` wraps both URLs through `GIT_CORS_PROXY`. Verify by checking the Network tab — both requests should go through `codex-git-proxy.ryderwishart.workers.dev`.

- [ ] **Step 6.8 — Deploy**

```bash
npm run deploy
```

Expected: new deployment URL surfaces. Test once more on the deployed branch alias.

- [ ] **Step 6.9 — Push**

```bash
git push
```

---

## Self-review

Reading the spec sections against the plan:

- **Spec §Overview / data flow** → Tasks 1-4 collectively implement it; Task 4 composes the full pipeline.
- **Spec §Components** → Tasks 1, 2, 3, 4, 5, 6 map 1-to-1 to the new files. Modified files covered in Task 1 (types) + Task 6 (EditorTable + CellData surface).
- **Spec §Cache strategy** → Task 2 implements location (`/lfs-cache/<first2>/<oid>`), sha256 integrity, no eviction.
- **Spec §Error handling** → `LfsDownloadError` in `download.ts` (Task 3) covers `batch-failed` / `download-failed`. `useCellAudio` (Task 4) adds `pointer-missing` / `pointer-invalid` / `no-session` / `no-git-origin`. `CellAudioButton` (Task 5) maps each kind to a tooltip.
- **Spec §Auth** → `download.ts` (Task 3) builds `Basic oauth2:<token>` exactly as `git-sync.ts:61` does.
- **Spec §CORS** → `download.ts` wraps both URLs through `GIT_CORS_PROXY` via the `proxied()` helper.
- **Spec §Testing** → Tasks 1, 2, 3, 4 each ship tests matching the spec's coverage list. No E2E / visual regression is called for and none is in the plan.
- **Spec §Non-goals** → the plan doesn't add upload, waveform, prefetch, `MediaSource`, or attachment-history UI. ✓

**Placeholder scan:** no TBD / TODO / "implement later" / "add error handling" text. Every code block is complete. ✓

**Type consistency:** `AudioError.kind` matches `errorTooltip`'s switch cases across Tasks 4 and 5. `LfsDownloadError` in Task 3 matches the types thrown-and-caught in Task 4. `CodexCellAttachment` defined in Task 1 is used in Tasks 4-6. ✓

---

## Plan-end push

- [ ] **Push the completed branch**

```bash
git push
```

- [ ] **Open PR when ready** — separate step; ask the user first.
