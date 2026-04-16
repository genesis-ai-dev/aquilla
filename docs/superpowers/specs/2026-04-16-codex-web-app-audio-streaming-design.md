# Audio Streaming (Read-Only) — Design

**Date:** 2026-04-16
**Status:** Approved design
**Predecessors:**
- M13 Phase 3 — `2026-04-15-codex-web-app-milestone13-phase3-git-merge-design.md`
- Reference implementation — `/Users/ryderwishart/frontierrnd/codex-editor/src/utils/lfsHelpers.ts`, `/Users/ryderwishart/frontierrnd/frontier-authentication/src/git/GitService.ts`

## Goal

Play per-cell audio attachments stored in cloned git projects without running git-LFS in the browser. Audio bytes live in Cloudflare R2 behind GitLab's LFS batch API at `git.genesisrnd.com`; we fetch the bytes on demand via the existing `codex-git-proxy` CORS worker, cache them in OPFS, and expose a compact play/pause button in each cell row.

**Explicitly read-only for MVP.** Upload (recording new audio in the browser and pushing it to LFS) is out of scope and deferred to a separate milestone.

## Non-goals

- Uploading or recording audio in the browser.
- Streaming via `MediaSource` / range-request chunking — per-cell clips are small enough (~50-200 KB typical) that `<audio src="blob:...">` is sufficient.
- Eager prefetch of all audio in a project.
- Waveform visualization, scrubbing, or timeline UI.
- Support for attachments where `isDeleted === true`.
- Detecting new audio added on the desktop since last sync (that's covered by the existing sync flow; once `.codex` is updated, the pointer URLs follow).
- Multi-attachment UI — we only render the one that `selectedAudioId` points to.
- Transcription, ASR integration, or any playback-analytics surface.

## Constraints

- **CORS:** GitLab's `/<repo>.git/info/lfs/objects/batch` endpoint does NOT return permissive CORS headers; the browser cannot call it directly. The R2 `download.href` CORS status is untested, but we assume it may also be closed.
- **No new backend.** The `codex-git-proxy` worker already forwards requests to `git.genesisrnd.com` with `Access-Control-Allow-Origin: *`, and accepts arbitrary methods/headers. Both the batch POST and the bytes GET go through it.
- **Auth:** The browser has `session.gitlabToken` (PAT, scoped `read_api`/`read_repository`). We send `Authorization: Basic oauth2:<token>` for the batch call. The `header` returned in the LFS batch response is used verbatim for the blob GET.
- **Integrity:** Every downloaded blob is SHA-256-verified against the pointer oid before it's served or cached.
- **Cache persistence:** OPFS is origin-scoped and survives across tabs and page reloads. Browser can evict under storage pressure; we accept that.

## Data flow

```
┌─ Cell render ────────────────────────────────────────────────────┐
│                                                                   │
│   cell.metadata.selectedAudioId = "audio-abc"                     │
│   cell.metadata.attachments["audio-abc"].url                      │
│     = ".project/attachments/files/JUD/audio-abc.webm"             │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
                                │
                                │ user clicks ▶
                                ▼
┌─ useCellAudio hook ───────────────────────────────────────────────┐
│                                                                   │
│   1. Open repo OPFS dir, readFile(attachment.url)                 │
│         ↓ text                                                    │
│      parsePointerContent(text) → { oid, size }                    │
│                                                                   │
│   2. lfsCacheGet(oid) → Uint8Array | null                         │
│                                                                   │
│   3. if null:                                                     │
│        downloadLfsBlob({ cloneUrl, gitlabToken, oid, size })      │
│          ├─ POST {PROXY}/{cloneUrl}/info/lfs/objects/batch        │
│          │    body: { operation: "download", objects: [{oid,size}]}│
│          │  → { objects: [{ actions: { download: { href, header }}}]}│
│          └─ GET  {PROXY}/{href} with header                       │
│               → bytes                                             │
│        verify sha256(bytes) === oid                               │
│        lfsCachePut(oid, bytes)                                    │
│                                                                   │
│   4. audioUrl = URL.createObjectURL(new Blob([bytes]))            │
│   5. <audio src={audioUrl}>.play()                                │
│                                                                   │
│   on unmount / selection change: URL.revokeObjectURL(audioUrl)    │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

Subsequent clicks with the same `selectedAudioId` bypass step 3.

## Components

### New files

```
src/lib/lfs/
  pointer.ts                         # parsePointerContent(text) → {oid, size} | null
  download.ts                        # downloadLfsBlob(args) → Uint8Array
  cache.ts                           # lfsCacheGet(oid) / lfsCachePut(oid, bytes)

src/hooks/
  useCellAudio.ts                    # state machine: idle → loading → ready | error

src/components/
  CellAudioButton.tsx                # compact ▶/⏸ button + spinner + error icon
```

### Modified files

```
src/lib/codex-editor/types.ts        # Add attachments?, selectedAudioId? on
                                     # CodexCellMetadata. Additive, no migration.

src/components/EditorTable.tsx       # Render <CellAudioButton> in rows where
                                     # cell.metadata.selectedAudioId is truthy.
```

### Module responsibilities

**`pointer.ts`** — pure function. Ported from `codex-editor/src/utils/lfsHelpers.ts:68-97`. Also exposes a guard `isLfsPointerContent(bytes: Uint8Array)` for the download-retry path (detects nested pointer-as-blob edge case).

**`download.ts`** — the two-call flow. Ported from `frontier-authentication/src/git/GitService.ts:648-728` minus Node-only bits (`Buffer` → `Uint8Array`, native `AbortController`, native `fetch`). Routes both calls through `GIT_CORS_PROXY`. Input: `{ cloneUrl, gitlabToken, oid, size, signal? }`. Output: `Uint8Array`. Verifies `sha256` before returning.

**`cache.ts`** — thin OPFS blob cache keyed by oid. Layout: `/lfs-cache/<first2hex>/<oid>`. Sharding by first 2 hex chars so any single dir has ≤ ~100 entries in practice. Reads/writes through `navigator.storage.getDirectory()`, separate from the repo dirs at `/repos/<repoKey>/`. **Not** inside repo state — survives re-imports and is invisible to git's `statusMatrix`.

**`useCellAudio.ts`** — hook with signature:

```ts
function useCellAudio(project: ProjectRecord, cell: CodexCell): {
  state: "idle" | "loading" | "ready" | "error"
  error: { kind: "pointer-missing" | "pointer-invalid" | "batch-failed" | "download-failed"; message: string } | null
  isPlaying: boolean
  play: () => Promise<void>
  pause: () => void
}
```

Owns the object-URL lifecycle. Revokes on unmount or when `selectedAudioId` changes. Internal `useRef<HTMLAudioElement>` so pause/play state stays synced with the element.

**`CellAudioButton.tsx`** — renders a 24-28px button using `lucide-react` icons. Four visual states keyed off the hook's return:
- **idle / ready not playing** → `<Play>` icon, enabled
- **loading** → `<Loader2 className="animate-spin">`
- **ready + isPlaying** → `<Pause>` icon, enabled
- **error** → `<AlertCircle>` icon, tooltip with `error.message`, click retries

Only renders when `cell.metadata.selectedAudioId` is truthy and the referenced attachment has `isDeleted !== true`.

## Cache strategy

- **Location:** `/lfs-cache/<first2hex>/<oid>` at the OPFS root. **Not** inside any repo dir.
- **Key:** the LFS oid (64-hex SHA-256). Same oid across projects = one cache entry, shared.
- **Integrity:** writes verify `sha256(bytes) === oid`; mismatches throw without writing.
- **Eviction:** none in MVP. Per-cell audio averages 50-200 KB; even heavy projects cap out well under browser storage quotas. Browsers can evict OPFS under pressure; cache misses recover cleanly.
- **Cross-tab:** free (OPFS is origin-scoped).
- **Reset:** no user-facing "clear audio cache" button in MVP. If debugging requires it, manual DevTools clear of OPFS works.

## Error handling

Four distinct failure modes, all surface through `CellAudioButton`'s error tooltip. No modal, no toast — per-row errors stay local to the row.

| Failure | Trigger | Tooltip | Retry |
|---|---|---|---|
| `pointer-missing` | `fs.readFile(attachment.url)` rejects (ENOENT) or file not found in repo OPFS | "Audio not available — sync the project" | Click retries (may succeed after sync) |
| `pointer-invalid` | File exists but `parsePointerContent` returns `null` | "Audio format unrecognized" | Not useful; retry does nothing differently but we allow it |
| `batch-failed` | LFS batch returns non-200 OR response lacks `actions.download.href` | "Couldn't reach audio server" | Click retries |
| `download-failed` | Blob GET non-200, network error, OR `sha256(bytes) !== oid` | "Audio download corrupted — try again" | Click retries |

All failures `console.error` with a structured payload `{ cellId, oid?, attachmentUrl, stage, underlying }` for Sentry-style ingestion if we add that later.

**Attachments with `isDeleted: true`** → button does not render at all.
**Attachments with `isMissing: true` (legacy flag)** → treated same as `pointer-missing` (button renders, click surfaces the error).
**Simultaneous playback of multiple cells** → not managed; browser plays multiple `<audio>` elements concurrently. That's fine for MVP.

## Auth

Re-used from existing sync code (`git-sync.ts:61`):

```ts
const authHeader = `Basic ${btoa(`oauth2:${session.gitlabToken}`)}`
```

Applied to the LFS batch POST only. The blob GET uses whatever `header` came back in the batch response's `download.header` — typically that's a pre-signed URL with no extra header required, but we pass anything GitLab returns verbatim.

## CORS

Both HTTP calls go through `GIT_CORS_PROXY` = `https://codex-git-proxy.ryderwishart.workers.dev`. Verified preflight behavior (2026-04-16):
- `OPTIONS {proxy}/git.genesisrnd.com/<repo>.git/info/lfs/objects/batch` → 204 with `access-control-allow-origin: *`, allowed headers include `authorization,content-type,accept`, allowed methods include `GET,POST,OPTIONS`.

## Testing strategy

### Unit — pure

- `pointer.test.ts`: valid pointer parses to `{oid, size}`; malformed (wrong version, missing oid, missing size, oversized) returns `null`. Fixture data ported from `codex-editor/src/test/suite/audioAttachmentsRestoration.test.ts`.
- `isLfsPointerContent`: sub-400-byte texts with the LFS signature are recognized; larger bodies short-circuit to `false`.

### Unit — network-mocked

- `download.test.ts`: `vi.fn()` over `fetch`.
  - Batch returns `{ objects: [{ actions: { download: { href, header } } }] }` → GET fires → bytes returned
  - Batch returns `{ objects: [{ error: { code: 404, message } }] }` → throws `batch-failed`
  - GET returns bytes but sha256 doesn't match → throws `download-failed`
  - GET returns a nested pointer (LFS-of-LFS edge case) → retries once, then gives up (matches `GitService.ts:740-760` behavior)

### Unit — cache

- `cache.test.ts` using the existing `MemoryDirectoryHandle` fixture from Phase 2:
  - Put then get returns identical bytes
  - Get for unknown oid returns `null`
  - Put with wrong sha256 throws without writing

### Integration — hook state machine

- `useCellAudio.test.tsx` with `@testing-library/react` + `fake-indexeddb` + mocked OPFS + `vi.fn()` fetch:
  - Happy path: idle → loading → ready, `play()` resolves, `audioUrl` set
  - Cache hit replay: second mount with same oid goes straight to ready without firing `fetch`
  - Each error kind surfaces correctly in `error.kind`
  - Unmount revokes the object URL (spy on `URL.revokeObjectURL`)

### Manual

- Deploy branch alias → open a project with real audio → click play on a cell → hear the audio; inspect network tab for exactly one batch POST + one GET on first play and zero extra network on replay.

No E2E/visual regression; `<audio>` is browser-standard.

## Scope discipline — what we are NOT building in MVP

- Upload / recording workflow.
- A "cache indicator" or "preload" UI.
- Attachment-history UI (showing non-selected attachments).
- Waveform, scrubber, volume, playback speed.
- Cross-cell playback coordination (auto-advance, play queues, keyboard shortcuts).
- LFS filter integration or working-tree mirroring of resolved bytes.
- Telemetry on playback.
- Any server-side addition to `api.frontierrnd.com`. If we want one later (for Tauri / mobile), the right shape is `GET /api/v2/audio/:projectId/:oid` but that's a separate milestone.

## Open follow-ups (post-MVP)

- If OPFS cache grows unbounded on real projects, add an LRU sweeper triggered on low storage.
- If first-play latency is annoying, add visible-cells prefetch on scroll using `IntersectionObserver`.
- If the R2 `download.href` turns out to be CORS-open in practice, wire a direct-fetch fast path and fall back to the proxy only on CORS failure (~10 lines, saves one worker hop).
- A `TranscriptPanel` that surfaces the attachment's ASR transcript (the `api.frontierrnd.com/api/v1/asr` endpoint exists and could be triggered on first play).
- Upload flow — requires LFS `operation: "upload"` batch call + PUT to signed URL + verify callback. Separate, larger spec.
