# Sync-Worker Test Failure Diagnosis

Generated: 2026-05-30  
Branch: main (HEAD 8e35c2b, plus dirty working-tree in the event layer)

---

## Summary Table

| Test | Type | Severity | 1-line fix |
|------|------|----------|------------|
| admin: "deletes every object under projects/:pid/files/:fid/" | STALE-TEST | Low | Change `expect(body.deleted).toBe(5)` to `.toBe(4)` and `toBe(before - 5)` to `toBe(before - 4)` |
| admin: "URL-encoded projectId / fileId are decoded before prefix matching" | STALE-TEST | Low | Change `expect(body.deleted).toBe(3)` to `.toBe(2)` |
| admin: "honors R2_KEY_PREFIX when listing and deleting" | STALE-TEST | Low | Fix `_allKeys()` to sort, or sort the expected array to match insertion order |
| audio: "DELETE requires SYNC_SECRET_KEY bearer (not the sync-token)" | STALE-TEST | Medium (see below) | Update test to reflect F8 intentional design: sync-token DELETE is now allowed for same-file owner |
| files-read: "returns populated file rollup rows for a member" | CODE-BUG | Medium | Update `d1-fake.ts` to match the new SQL column list `role, kind, event_id, meta` |
| files-read: "returns the single file for the by-id variant" | CODE-BUG | Medium | Same as above — d1-fake SQL matcher misses the new column set |

---

## Failure 1 — admin: "deletes every object under projects/:pid/files/:fid/"

**Test:** `sync-worker/src/__tests__/admin.test.ts:133`  
**Expectation:** `expect(body.deleted).toBe(5)` and `expect(env.SNAPSHOTS._size()).toBe(before - 5)`  
**Actual:** `body.deleted === 4`, `_size()` differs by 4

### Root cause: STALE-TEST

`seedFile()` was changed in commit `923a086` ("chore: remove Snapshots feature"):

```diff
// sync-worker/src/__tests__/admin.test.ts:76-85
 function seedFile(env: any, projectId: string, fileId: string, tails: number) {
   const prefix = `projects/${projectId}/files/${fileId}`
-  env.SNAPSHOTS._seed(`${prefix}/snapshot.bin`, new Uint8Array([1, 2, 3]))  // removed
   for (let i = 0; i < tails; i++) {
     env.SNAPSHOTS._seed(`${prefix}/tail/${...}.bin`, ...)
   }
   env.SNAPSHOTS._seed(`${prefix}/checkpoints/ckp-1.bin`, ...)
 }
```

After that commit, `seedFile(env, "proj-1", "file-a", 3)` seeds exactly **4** objects (3 tails + 1 checkpoint). But the assertion on line 150 still reads `toBe(5)` with a comment update that was left incorrect ("3 tails + 1 checkpoint × 2 files = 5 in file-a" is mathematically wrong and the count wasn't adjusted).

**Implementing code:** `sync-worker/src/admin.ts:99–113` — correctly enumerates and deletes all objects under the prefix. The handler is correct.

**Recommended fix:** `sync-worker/src/__tests__/admin.test.ts:150,155`

```ts
expect(body.deleted).toBe(4) // 3 tails + 1 checkpoint
// ...
expect(env.SNAPSHOTS._size()).toBe(before - 4)
```

**Severity:** Low. No production code bug; test arithmetic is wrong.  
**Collision risk:** `admin.test.ts` is NOT in the dirty set. Safe to fix in isolation.

---

## Failure 2 — admin: "URL-encoded projectId / fileId are decoded before prefix matching"

**Test:** `sync-worker/src/__tests__/admin.test.ts:189`  
**Expectation:** `expect(body.deleted).toBe(3)` at line 201  
**Actual:** `body.deleted === 2`

### Root cause: STALE-TEST

Same `seedFile` change as Failure 1. `seedFile(env, "proj 1", "file/a", 1)` now seeds 1 tail + 1 checkpoint = **2** objects. The test previously expected 3 (when `snapshot.bin` was also seeded). The assertion was not updated when `seedFile` had `snapshot.bin` removed.

**Implementing code:** `sync-worker/src/admin.ts:86–113` — URL decoding and prefix matching are correct (verified by the handler accepting `proj%201`/`file%2Fa` and finding the right keys).

**Recommended fix:** `sync-worker/src/__tests__/admin.test.ts:201`

```ts
expect(body.deleted).toBe(2) // 1 tail + 1 checkpoint
```

**Severity:** Low. Test arithmetic wrong; decode logic works.  
**Collision risk:** `admin.test.ts` NOT in the dirty set. Safe to fix.

---

## Failure 3 — admin: "honors R2_KEY_PREFIX when listing and deleting"

**Test:** `sync-worker/src/__tests__/admin.test.ts:204`  
**Expectation:** `expect(env.SNAPSHOTS._allKeys()).toEqual(["projects/p/files/f/checkpoints/ckp-1.bin", "projects/p/files/f/tail/0.bin"])`  
**Actual:** `["projects/p/files/f/tail/0.bin", "projects/p/files/f/checkpoints/ckp-1.bin"]` (insertion order)

### Root cause: STALE-TEST

In commit `923a086`, the "honors R2_KEY_PREFIX" test was rewritten to add `checkpoints/ckp-1.bin` as the second non-prefixed key and `tail/0.bin` as the first. Seeds happen in this order:
1. `pr-7/projects/p/files/f/tail/0.bin`
2. `pr-7/projects/p/files/f/audio/clip.webm`
3. `pr-7/projects/p/files/f/checkpoints/ckp-1.bin`
4. `projects/p/files/f/tail/0.bin`  ← inserted 4th
5. `projects/p/files/f/checkpoints/ckp-1.bin`  ← inserted 5th

After deleting the 3 `pr-7/...` keys, `_allKeys()` returns insertion order: `["projects/p/files/f/tail/0.bin", "projects/p/files/f/checkpoints/ckp-1.bin"]`. The test expects alphabetical order `["checkpoints/...", "tail/..."]`, which is the reverse.

The stub bucket's `_allKeys()` method (`admin.test.ts:54–56`) returns `Array.from(store.keys())` — insertion order, not sorted. The test was written expecting sorted output (probably copied from the original which had only `["projects/p/files/f/snapshot.bin"]` — a single element, so order didn't matter).

**Implementing code:** `sync-worker/src/admin.ts:94–101` — correct; lists with prefix and deletes. The R2_KEY_PREFIX scoping works.

**Recommended fix (option A — fix test expectation to match insertion order):**

```ts
// sync-worker/src/__tests__/admin.test.ts:227
expect(env.SNAPSHOTS._allKeys()).toEqual([
  "projects/p/files/f/tail/0.bin",
  "projects/p/files/f/checkpoints/ckp-1.bin",
])
```

**Recommended fix (option B — sort both sides):**

```ts
expect([...env.SNAPSHOTS._allKeys()].sort()).toEqual([
  "projects/p/files/f/checkpoints/ckp-1.bin",
  "projects/p/files/f/tail/0.bin",
])
```

Option A is simpler and directly reflects what `_allKeys()` actually does. Option B is more defensive.

**Severity:** Low. The R2_KEY_PREFIX scoping is correct; only ordering assumption is wrong.  
**Collision risk:** `admin.test.ts` NOT in the dirty set. Safe to fix.

---

## Failure 4 — audio: "DELETE requires SYNC_SECRET_KEY bearer (not the sync-token)"

**Test:** `sync-worker/src/__tests__/audio.test.ts:216`  
**Expectation:** A DELETE request with a valid sync-token JWT returns `401`  
**Actual:** Returns `200`

### Root cause: STALE-TEST (intentional code change, test not updated)

In commit `1811d31` ("fix(cells+audio): lock re-check, stale-source/sibling banners, R2 orphan cleanup"), the DELETE handler in `audio.ts` was deliberately extended with **Feature F8**: allow sync-token JWT holders to delete their own audio file's objects.

The before/after in `audio.ts:86–111`:

**Before (original design):**
```ts
// Only SYNC_SECRET_KEY allowed to DELETE
const expected = env.SYNC_SECRET_KEY ? `Bearer ${env.SYNC_SECRET_KEY}` : null
if (!expected || auth !== expected) {
  return withAudioCors(new Response("unauthorized", { status: 401 }))
}
await env.SNAPSHOTS.delete(key)
return withAudioCors(Response.json({ ok: true }))
```

**After (current code, audio.ts:86–111):**
```ts
// Admin path: SYNC_SECRET_KEY bearer is allowed
const adminExpected = env.SYNC_SECRET_KEY ? `Bearer ${env.SYNC_SECRET_KEY}` : null
if (adminExpected && auth === adminExpected) {
  await env.SNAPSHOTS.delete(key)
  return withAudioCors(Response.json({ ok: true }))
}
// F8: also allow the sync-token owner (contributor+) to DELETE
const token = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : null
const verified = await verifyTokenForFile(token, fileId, env.SYNC_SECRET_KEY)
if (!verified.ok) {
  return withAudioCors(new Response("unauthorized", { status: 401 }))
}
if (verified.claims.projectId !== projectId) {
  return withAudioCors(new Response("token scoped to different project", { status: 403 }))
}
await env.SNAPSHOTS.delete(key)
return withAudioCors(Response.json({ ok: true }))
```

The test at `audio.test.ts:220–227` sends a DELETE with a sync-token scoped to `(projectId="p1", fileId="f1")` and expects `401`. Under the new code, `verifyTokenForFile` succeeds (token is valid, scoped to the right file), and the projectId check passes, so the handler returns `200`.

### Is this a real auth bypass / security vulnerability?

**No, this is not a security vulnerability.** The new code has correct checks:

1. The sync-token must be cryptographically valid (signed with `SYNC_SECRET_KEY`, not expired)
2. The token's `aud` must be `"sync"` (line 164 of `auth.ts`)
3. The token's `fileId` must match the URL `fileId` (line 168 of `auth.ts`)
4. The token's `projectId` must match the URL `projectId` (audio.ts:105)

This means only the holder of a valid token scoped to that exact `(project, file)` can delete that file's audio — exactly as strong as the PUT/GET authorization. The feature was intentionally added to let the client clean up an orphaned R2 blob when `emitCellAudioAttach` fails after a successful PUT (the client needs to roll back the R2 upload).

The test name "DELETE requires SYNC_SECRET_KEY bearer (not the sync-token)" is now **factually incorrect** — the test title describes the old design.

**Recommended fix:** `sync-worker/src/__tests__/audio.test.ts:216–242`

Update the test to reflect the current design: split into two assertions:
1. A DELETE with an **invalid/unsigned** token still returns `401`
2. A DELETE with a valid sync-token scoped to the correct `(project, file)` returns `200`
3. A DELETE with `SYNC_SECRET_KEY` bearer still returns `200`

The test should be renamed to "DELETE allows either SYNC_SECRET_KEY or a valid sync-token scoped to the file (F8)".

**Severity:** Medium for the failing test (it's a security invariant test that now gives false confidence it covers admin-only), but the production code path is NOT vulnerable. The real risk is that the stale test could be interpreted as a false green signal on the old behavior — it should be updated to document the actual policy.  
**Collision risk:** `audio.test.ts` is NOT in the dirty set. Safe to fix.

---

## Failure 5 — files-read: "returns populated file rollup rows for a member"

**Test:** `sync-worker/src/__tests__/files-read.test.ts:13`  
**Expectation:** `expect(body.files).toHaveLength(2)`  
**Actual:** `body.files === []`

### Root cause: CODE-BUG (d1-fake.ts has stale SQL pattern — not updated when files-read-route.ts changed)

In commit `51c2985` ("phase 2c-γ step 1"), `files-read-route.ts` was ported to the v3 data model. The SQL `columns` string changed:

**Before (original, `files-read-route.ts` line 110 pre-51c2985):**
```ts
"id, project_id, name, file_type, source_language, target_language, " +
"cell_count, approved_count, word_count, last_edit_at"
```

**After (current, `files-read-route.ts:110–111`):**
```ts
"id, project_id, name, role, kind, event_id, meta, " +
"cell_count, approved_count, word_count, last_edit_at"
```

The `d1-fake.ts` at lines 494–522 still matches the OLD column list:

```ts
// d1-fake.ts:495 — still matches old columns, not the current ones
if (
  /^SELECT id, project_id, name, file_type, source_language, target_language, cell_count, ...
```

When the list route is called, `execSql()` receives the new SQL string (`...name, role, kind, event_id, meta, cell_count...`), falls through ALL pattern matchers without matching, and returns `[]` (the default at line 1231). The route's `.all<FileRowRaw>()` returns `{ results: [] }`, so the response is `{ files: [] }`.

**Both the test (`files-read.test.ts`) and `d1-fake.ts` need updates.** The test file seeds files with old-schema fields (`file_type`, `source_language`) which still exist in the `FileRow` interface in `d1-fake.ts` — so the test seeds work. Only the SQL pattern matchers in `d1-fake.ts` need to be updated to recognize the new SELECT columns.

**Recommended fix:** `sync-worker/src/__tests__/helpers/d1-fake.ts:494–548`

Replace the two `SELECT ... FROM files` matchers to match the new column list:

```ts
// List query
if (
  /^SELECT id, project_id, name, role, kind, event_id, meta, cell_count, approved_count, word_count, last_edit_at FROM files WHERE project_id = \? ORDER BY/.test(
    normalized,
  )
) {
  const pid = args[0] as string
  return db.files
    .filter((f) => f.project_id === pid)
    .map((f) => ({
      id: f.id,
      project_id: f.project_id,
      name: f.name ?? "",
      role: null,
      kind: f.file_type ?? null,
      event_id: "",
      meta: JSON.stringify({
        source_language: f.source_language ?? null,
        target_language: f.target_language ?? null,
      }),
      cell_count: f.cell_count ?? 0,
      approved_count: f.approved_count ?? 0,
      word_count: f.word_count ?? 0,
      last_edit_at: f.last_edit_at ?? null,
    }))
    .sort((a, b) => { /* same sort logic */ })
}

// Single-file query
if (
  /^SELECT id, project_id, name, role, kind, event_id, meta, cell_count, approved_count, word_count, last_edit_at FROM files WHERE project_id = \? AND id = \?$/.test(
    normalized,
  )
) {
  // ... same pattern with new columns
}
```

Note: the `FileRow` interface in `d1-fake.ts` still has `file_type`, `source_language`, `target_language` fields — these can be kept for test seeding compatibility and mapped into `kind`/`meta` in the pattern handler.

**Severity:** Medium. This is a genuine test infrastructure gap — the route produces real SQL that the fake doesn't handle, returning empty results and silently masking the feature. Rollup reads return nothing to the client, which would be visible in the app.  
**Collision risk:** `d1-fake.ts` IS in the dirty set (currently modified with INSERT events changes). The fix for the files-read SQL patterns is in lines 494–548 of `d1-fake.ts`, which is a DIFFERENT section from the dirty change (lines 630–700, INSERT events). These sections do not overlap. However, any PR touching `d1-fake.ts` will need to merge with the in-flight change — coordinate with the developer who owns the current dirty state.

**`files-read.test.ts` also needs a minor update:** The test seeds files using old-schema fields (`file_type`, `source_language`, `target_language`) which still match `FileRow` in d1-fake, so no seed changes are needed. The test assertions check `body.files[0].fileId`, `body.files[0].cellCount` — these should work once the fake SQL matchers are fixed.

---

## Failure 6 — files-read: "returns the single file for the by-id variant"

**Test:** `sync-worker/src/__tests__/files-read.test.ts:83`  
**Expectation:** `expect(res.status).toBe(200)` and `expect(body.file.fileId).toBe("file-x")`  
**Actual:** `res.status === 404`

### Root cause: CODE-BUG (same as Failure 5)

The single-file variant hits the same root cause: `files-read-route.ts:114` issues:
```sql
SELECT id, project_id, name, role, kind, event_id, meta, cell_count, approved_count, word_count, last_edit_at
  FROM files WHERE project_id = ? AND id = ?
```

`d1-fake.ts:526` still matches:
```ts
/^SELECT id, project_id, name, file_type, source_language, target_language, cell_count, approved_count, word_count, last_edit_at FROM files WHERE project_id = \? AND id = \?$/
```

No match → `execSql` returns `[]` → `.first<FileRowRaw>()` returns `null` → route returns `404`.

**Recommended fix:** Same as Failure 5 — update the second files matcher in `d1-fake.ts:525–548`.

**Severity:** Medium. Same as Failure 5.  
**Collision risk:** Same as Failure 5 — `d1-fake.ts` is dirty, sections don't overlap with the in-flight change.

---

## Audio Auth Verdict

**This is NOT a real security vulnerability.** The audio DELETE route was intentionally extended in commit `1811d31` to support F8 (client-side orphan cleanup). The new path requires:
- Valid JWT signed with `SYNC_SECRET_KEY`
- Audience `"sync"`
- Token `fileId` claim matches URL fileId
- Token `projectId` claim matches URL projectId

This is the same authorization posture as PUT/GET. The test title is stale — it describes the pre-F8 design. The fix is to update the test to document the actual dual-auth policy.

---

## Collision Risk Summary

| File to fix | In dirty set? | Notes |
|-------------|---------------|-------|
| `sync-worker/src/__tests__/admin.test.ts` | No | Safe to fix independently |
| `sync-worker/src/__tests__/audio.test.ts` | No | Safe to fix independently |
| `sync-worker/src/__tests__/files-read.test.ts` | No | No changes needed (seeds are compatible) |
| `sync-worker/src/__tests__/helpers/d1-fake.ts` | **YES** | Fix is in lines 494–548; in-flight change is in lines 630–700; no overlap, but must merge carefully |

The 3 admin/audio failures are in entirely separate files from the event-layer refactor — they can be fixed without touching any file in the dirty set. The 2 files-read failures require touching `d1-fake.ts`, which is dirty, but the section of `d1-fake.ts` that needs changing (files SQL matchers at ~line 494–548) is distinct from the in-flight changes (INSERT events handler at ~line 630–700).
