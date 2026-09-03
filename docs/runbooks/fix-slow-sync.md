# Slow-link editor sync fix

Branch: `fix-slow`. No deployment or production mutation is part of this change.

## Changed contracts

- The editor's full read requests `pagination=keyset&limit=2000`. The Worker
  selects at most `limit + 1` rows from Postgres using `(side, target_lang,
  cell_id)` after the last returned key. It counts rows only on the first page.
  The client reconstructs anchor order; legacy/external ordered reads are
  unchanged. Null or mutable `sequence_index` values cannot break pagination.
- Each side's pagination token carries its starting safe event watermark,
  project epoch, rebuild marker and query scope. Settling a pending sequence
  allocation does not change that watermark mid-stream. A changed incarnation
  or rebuild rejects continuation rather than mixing datasets silently.
- Both editor cell stores follow a completed keyset scan with a delta from
  the earliest watermark. That recovers edits and inserts behind the transport
  cursor. Existing local-write protection and legacy torn-snapshot guards stay
  intact. Superseded file reads are aborted, including active response bodies.
- The primary cell editor is writable only after a focus-lock acknowledgement.
  It pauses on disconnect, failed renewal delivery, or lease expiry. Re-claims
  solicit acknowledgements using the existing Worker protocol. Deadlines start
  at send time so response latency cannot extend a lease. Already-typed edits
  still use the existing durable outbox; this is not a CRDT or an offline merge.
- Remote presence drafts never replace saved/local-outbox text. Presence and
  caret indicators remain, but full unsaved peer text is not painted as the
  authoritative cell value. Losing branches remain in edit history.

## Rollout

1. Apply `db/postgres/migrations/0083_cells_scan_index.sql` to the intended
   environment. It is one `CREATE INDEX CONCURRENTLY` statement; do not wrap
   it in an explicit transaction or concatenate it with other migrations.
   Check `pg_index.indisvalid` for `idx_cells_file_scan` after an interrupted
   build: `IF NOT EXISTS` alone does not repair an invalid concurrent index.
2. Deploy the sync Worker, then the SPA. The scan is opt-in so older clients
   retain compatibility. New clients talking to an old Worker retain the
   legacy per-page watermark guard, but do not gain the bounded DB read yet.
3. Retest the affected large file with two users under 3G throttling. Confirm
   waiting-for-lock is read-only, saved text never blanks on peer presence,
   edits persist after reload, and a warm refresh uses `since=` deltas.
4. Compare `/cells` latency, Worker memory failures, database waiting sessions,
   and backlog recovery. These fixes do not by themselves eliminate all slow
   write transactions, sequence-allocation TTL risks, or unrelated Worker errors.

## Verification / test impact

- Worker -> actual SPA read wrappers: `cells-keyset.test.ts` covers bounded SQL,
  closing fast/slow watermark gaps, deletion during paging, insertion behind the
  cursor recovered by delta, cursor scope/epoch rejection, and multiple lanes.
- DO transition -> focus-lock hook: `useFocusLock.test.tsx` consumes the real
  `applyFocusClaim` output and covers initial permission, renewal, lost replies,
  delayed replies, repeated activation, disconnect/reconnect, takeover, release
  and unmount.
- Worker metadata -> both cell stores: existing `useCells.test.tsx` plus
  `useActiveCellStore.sync.test.tsx` cover watermarks, automatic delta catch-up,
  local-write protection and cancellation. `cells-read.test.ts` covers the new
  request options and cancellation without browser-specific signal methods.
- Presence store -> real editor row: `EditorTable.lane.test.tsx` covers empty
  and stale remote drafts plus read-only activation before acknowledgement.
  `EditorTable.editorActions.test.tsx` covers activation after AI completion;
  `TranslatedEditor.pendingInput.test.tsx` prevents replay before permission.
- Two browsers + local Workers + Postgres:
  `e2e/specs/collab/concurrent-edit.smoke.spec.ts` delays the real DO reply,
  asserts input is paused, releases it, switches cells without losing the new
  lease, and verifies Alice's commit reaches Bob.

Commands run:

```sh
pnpm exec vitest run src/hooks/useFocusLock.test.tsx src/hooks/useFocusLock.test.ts src/hooks/useCells.test.tsx src/hooks/useActiveCellStore.sync.test.tsx src/components/EditorTable.lane.test.tsx src/lib/sync/cells-read.test.ts scripts/e2e-determinism.test.ts --maxWorkers=2
pnpm --dir sync-worker exec vitest run src/__tests__/cells-read.test.ts src/__tests__/cells-keyset.test.ts --maxWorkers=1
pnpm exec vitest run src/components/EditorTable.editorActions.test.tsx src/components/TranslatedEditor.pendingInput.test.tsx src/components/TranslatedEditor.commit.test.tsx --maxWorkers=2
pnpm --dir sync-worker run type-check
npx tsx scripts/e2e-up.ts -- e2e/specs/collab/concurrent-edit.smoke.spec.ts
pnpm build
```

Targeted lint also ran: no errors, existing warnings in the large UI files.
The complete smoke suite remains the merge/deploy gate and was not run here.

## Spec follow-up

`aquilla-specs/02-foundations.md` AD-1 and `06-non-functional.md` Offline
Behavior have inconsistent wording about continued offline editing versus v1
requiring usable connectivity. This patch deliberately pauses **new input**
without a confirmed lease while preserving the existing outbox. Reconcile
AD-1 and `04-features/sync-and-presence.md` with that rule and with saved text
being separate from ephemeral presence previews. The sibling spec repository
was inspected but not changed. Linear authentication repeatedly requested a
retry, so no ticket/status or spec-repository commit was made in this run.
