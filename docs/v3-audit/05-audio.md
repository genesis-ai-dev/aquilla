# v3 Audit — Audio Assets

## Summary
Audio recording and playback are cleanly migrated to v3: R2 storage is canonical, D1 event-log projects audio metadata, and playback hooks read from D1 via `useFileAudioAttachments`. No legacy Yjs blob storage is actively used. One minor doc/code mismatch on TTS model hosting found.

## Chain of custody (as-built)
**Recording:** client records via MediaRecorder → blob → `uploadCellAudio` PUT to sync-worker `/audio/:projectId/:fileId/:audioId` (R2) with sync-token auth → `emitCellAudioAttach` event (D1 cell_audio table, selected=1) → `notifyAudioAttachmentsChanged` broadcast.

**Playback:** `useFileAudioAttachments` fetches `/api/v1/projects/:p/files/:f/audio-attachments` (D1 projection of cell_audio grouped by cell) → `useCellAudio` merges by selectedAudioId → `ensureBytes` fetches R2 via `/audio/:projectId/:fileId/:audioId` with sync-token auth → blob plays in HTMLAudioElement.

**Voice synth/clone:** Generated or cloned audio uploaded same as recordings, with extra metadata (voiceId, referenceAudioId, durationMs, timings) stored in cell_audio.

## Findings

### F1: MMS_R2_HOSTING.md predates v3 event log but is still accurate
- **Severity**: low
- **Category**: doc-mismatch
- **Evidence**: docs/MMS_R2_HOSTING.md:1-47 describes TTS model hosting for Sherpa-ONNX & legacy Xenova runtime; sync-worker/src/voice-convert.ts:1-44 reads voice reference clips from R2 `projects/{projectId}/voices/{referenceAudioId}` (same infrastructure as audio)
- **What's wrong**: Doc is v1/v2 focused (discusses in-browser MMS downloads, conversion pipeline) and doesn't mention that v3 event log now owns audio metadata. No stale instruction, but the context is pre-event-log.
- **Suggested fix**: Add a v3 section noting that MMS models still live in R2 (no change) but the event log now records clip metadata via `cell.audio.attach` projection.

### F2: cell_audio D1 table stores audio URL as pointer, not resolved path
- **Severity**: medium
- **Category**: mismatch
- **Evidence**: event-projection.ts:384-415 INSERT cell_audio columns `url, mime_type, voice_id, reference_audio_id, duration_ms, timings_json`; AudioRecordingModal.tsx:161-170 calls `emitCellAudioAttach({..., url: result.url})` where result.url is `frontier-audio://{audioId}.{ext}` per upload.ts:51-53
- **What's wrong**: The `url` column is a logical pointer scheme, not an HTTP path. Callers must parse via `parseFrontierAudioUrl` (upload.ts:42-49) to extract audioId, then resolve to R2 via `fetchCellAudio` at playback time. This is fine in practice but the name `url` is misleading — it's a reference, not a resolvable URL.
- **Suggested fix**: No action required for v3 (already working), but document that cell_audio.url is always `frontier-audio://` scheme and never a direct HTTP path, or rename to `audioRef`.

### F3: Legacy LFS audio detection but no migration path
- **Severity**: medium
- **Category**: legacy-v1
- **Evidence**: useCellAudio.ts:136-144 detects legacy GitLab LFS audio via `parseFrontierAudioUrl(...) === null`, throws "Unsupported audio URL (legacy LFS)" error
- **What's wrong**: The code gracefully degraded legacy LFS references (v1 recordings stored as Git LFS pointers), but there's no end-to-end migration path (re-record or import from LFS). Users with old cells that still reference LFS will see a "needs re-record" error. This is acceptable if the data is old, but no doc signals when LFS support ended.
- **Suggested fix**: Surface in release notes that LFS audio recordings cannot be played in v3; users must re-record or migrate manually. Consider a one-time import utility if backwards compat is desired.

### F4: OPFS peaks cache is v2/v3 shared but D1 is canonical for timings
- **Severity**: low
- **Category**: legacy-v2
- **Evidence**: peaks-cache.ts:1-69 caches decoded waveform peaks in OPFS keyed by audioId; cell-audio-read-route.ts:113-119 reads timings_json from D1 cell_audio and merges into audioTimings[audioId]; useCellAudio.ts doesn't read peaks from cell_audio, it decodes on-demand via decodePeaks.
- **What's wrong**: Peaks are ephemeral (localStorage-level cache), while timings are durable in D1. Works fine, but the asymmetry could confuse future maintainers. Peaks recompute on every first play or cache eviction; timings persist.
- **Suggested fix**: No action needed for v3 (already correct), but document that OPFS peaks are ephemeral caches while D1 timings are canonical.

### F5: emitCellAudioAttach parentId is always null (non-chain-mutating)
- **Severity**: low
- **Category**: design
- **Evidence**: events-emit.ts:227-248 calls enqueueEvent with `parentId: null` for cell.audio.attach; event-projection.ts:365-418 treats it as a non-chain-mutating projection (only writes cell_audio, no cell_validators update)
- **What's wrong**: Audio attachment is not part of the cell's edit chain (doesn't bump source/target event_id), so parentId is null. This is correct — audio is orthogonal to content. No bug, just a design note for v3 clarity.
- **Suggested fix**: None — this is correct by design.

### F6: Voice reference clips (Seed-VC) stored project-scoped, not per-file
- **Severity**: low
- **Category**: design
- **Evidence**: voice-convert.ts:37-44 voiceRefObjectKey constructs `projects/{projectId}/voices/{referenceAudioId}` (no fileId); cell-audio-read-route.ts accesses cell_audio.reference_audio_id but never reads the reference clip itself (client-side cloning flow reads it on demand)
- **What's wrong**: No bug, but reference clips are decoupled from file ownership. A project-wide voice can be used by any file's cells. This works but adds cross-file consistency risk if a voice is deleted.
- **Suggested fix**: No action for v3, but document that voice references are project-scoped (all files can use any voice in the project).

### F7: audioTimings stored as JSON string but no compression hint
- **Severity**: low
- **Category**: doc-mismatch
- **Evidence**: event-projection.ts:412 `p.timings ? JSON.stringify(p.timings) : null`; cell-audio-read-route.ts:113-119 `JSON.parse(r.timings_json)` with try/catch fallback (ignores malformed timings); useCellAudio.ts doesn't use timings, it's rendered by karaoke-plugin.ts
- **What's wrong**: Timings can be large for long clips (word-level granularity). No size limit or compression strategy is documented. D1 sqlite has a practical text column size limit; very dense timings (e.g., per-syllable) could hit it.
- **Suggested fix**: Document that cell_audio.timings_json must fit in sqlite TEXT column (~1GB in theory, but practical limit ~1MB per row). If timings are large, consider storing only a summary or range.

### F8: No orphan cleanup if R2 upload succeeds but event emit fails
- **Severity**: medium
- **Category**: bug
- **Evidence**: AudioRecordingModal.tsx:146-170 uploads blob via uploadCellAudio (PUT succeeds) → then emitCellAudioAttach fails (e.g., network error, auth revoked). The R2 object exists but is orphaned (not referenced in D1).
- **What's wrong**: The audio bytes sit in R2 indefinitely, wasting storage. No background cleanup process is in place. The cell_audio projection will never reference this audioId, and no dead-letter mechanism warns of the orphan.
- **Suggested fix**: Wrap uploadCellAudio + emitCellAudioAttach in a transaction-like flow: if emit fails, DELETE the R2 object before surfacing the error to the user. Alternatively, add a background cleanup job (via admin endpoint) to sweep unreferenced audio older than N days.

### F9: No validation of audioId format in R2 upload path
- **Severity**: low
- **Category**: design
- **Evidence**: audio.ts:30-37 audioObjectKey accepts projectId, fileId, audioId directly; uploadCellAudio (upload.ts:74-91) generates audioId via buildAudioId (upload.ts:34-39) which normalizes to `audio-{cellId}-{ts}-{random}`. No whitelist validation occurs in the handler.
- **What's wrong**: The handler trusts the client's audioId. If a client sends `../../etc/passwd` or similar, the URL-encoding in audioEndpoint (upload.ts:55-62) will escape it, but the decodeURIComponent in audio.ts:83 will restore it. No directory traversal risk due to R2's key model (no path semantics), but relying on URL encoding is fragile.
- **Suggested fix**: Validate audioId against a whitelist pattern (e.g., `/^[a-zA-Z0-9._-]+\.[a-zA-Z0-9]+$/`) in audio.ts:69-84 before constructing the key.

### F10: Playback hook doesn't detect stale audio (post-deletion orphan)
- **Severity**: low
- **Category**: edge-case
- **Evidence**: useCellAudio.ts:130-166 ensureBytes fetches from R2 via audioId; if the cell_audio row still references an audioId but the R2 object was deleted (admin cleanup, accidental delete), ensureBytes throws "download-failed" error. The UI surfaces it as a generic error, not a "audio was deleted" signal.
- **What's wrong**: No differentiation between transient network errors and permanent deletions. Users can't tell if they should retry, re-record, or wait for recovery.
- **Suggested fix**: Distinguish 404 (audio was deleted, not retriable) from 5xx/network errors (retry later). Return a new error kind `"audio-deleted"` and surface a specific UI message.

## Open questions
- Is there a background job to clean up orphaned R2 objects if an upload succeeds but the event emit fails?
- Should cell_audio.url be renamed to cell_audio.audio_ref for clarity (it's not a resolvable URL, it's a logical pointer)?
- Do users with pre-v3 LFS audio have a documented migration path, or should we surface a one-time import tool?
- Are there limits on timings_json size, or does it inherit sqlite TEXT limits?

## Files reviewed
- sync-worker/src/audio.ts (R2 storage handler, PUT/GET/DELETE)
- sync-worker/src/voice-convert.ts (Seed-VC integration, voice reference clips)
- sync-worker/src/events/cell-audio-read-route.ts (D1 projection read endpoint)
- sync-worker/src/events/event-projection.ts (cell.audio.attach & cell.audio.select projections)
- src/lib/audio/upload.ts (client R2 upload, URL scheme, audioId generation)
- src/lib/sync/cell-audio-read.ts (client-side fetch wrapper)
- src/hooks/useCellAudio.ts (playback controller, R2 fetch, error handling)
- src/hooks/useFileAudioAttachments.ts (per-file audio read via D1)
- src/components/AudioRecorder/AudioRecordingModal.tsx (recording modal, upload flow)
- src/lib/audio/peaks-cache.ts (OPFS peaks cache, ephemeral)
- docs/MMS_R2_HOSTING.md (TTS model hosting doc, v1/v2 era)
