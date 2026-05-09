# Editor Refactor Checklist

> **Status:** In progress on `refactor/data-persistence`. Working list.
> **Last updated:** 2026-05-08
> **Companion docs:** [DATA_PERSISTENCE_PLAN.md](./DATA_PERSISTENCE_PLAN.md), [CLEANUP_POST_REFACTOR.md](./CLEANUP_POST_REFACTOR.md).

The full surgery: replace Y.Doc-as-source-of-truth with the SQLite-WASM + outbox stack, demote Y.Doc to ephemeral co-edit sugar, and rebuild the cell editor on plain-text + placeholder tokens.

The work is broken into phases that can be reviewed and committed independently. **Each phase is a checkpoint where the test suite must stay green.**

---

## Phase A — Design completion (current)

The PM review correctly flagged that the plan was schema-thought-through for `translation_text` and **silent on every other component of `CellData`**. This phase closes that gap before any structural code lands.

- [x] Identify the cell-keyed vs edit-keyed split (PM input integrated)
- [x] Schema design for the full cell data model
- [x] Mutation-kind list with per-kind conflict policies
- [x] Mirror registry pattern documented
- [ ] [DATA_PERSISTENCE_PLAN.md](./DATA_PERSISTENCE_PLAN.md) updated:
  - [ ] §2 — Y.Doc role clarified: ephemeral sugar only, never persisted
  - [ ] §4 — full cell data schema (validations, waivers, backtranslations, threads, thread_messages, cell_attachments) with cell-keyed vs edit-keyed sections
  - [ ] new section — mutation kinds + conflict policies table
  - [ ] new section — mirror registry pattern
- [ ] Local-store migration 002 with new tables (additive only; never edit 001)
- [ ] `MIGRATIONS_LOCK.json` updated
- [ ] All 1544 unit + 5 Playwright tests still green

**Phase A exit criteria:** schema covers every field a downstream `CellData` consumer reads today, with a documented conflict policy for each. No code changes required to `useCells`, `useFileSync`, or the editor in this phase.

---

## Phase B — Mirror registry scaffolding

A pluggable hook that bridges Y.Doc → local-store. One mirror module per subsystem (translation, threads, attachments, etc.). Phase B builds the registry and ships exactly one registered mirror: `translation_text`.

- [ ] `src/lib/mirror-registry/registry.ts` — registry interface and hook
- [ ] `src/lib/mirror-registry/translation-text.ts` — first mirror: Y.XmlFragment → `cells.translation_text` + outbox enqueue
- [ ] Unit tests: registry, translation-text mirror with mock Y.Doc
- [ ] Doc comment in registry.ts explaining how to add a new mirror

**Phase B exit criteria:** registering a Y.Doc to the registry causes its translation edits to flow into local-store + outbox without disturbing the existing editor.

---

## Phase C — LocalStoreProvider + workspace bootstrap

A React context owns the per-project `LocalStore` instance. `ProjectWorkspace` opens the store on mount, runs migrations, attaches the mirror registry, and closes on unmount.

- [ ] `src/lib/local-store/provider.tsx` — `LocalStoreProvider`, `useProjectStore()`
- [ ] Wire into `ProjectWorkspace.tsx`: open per-project OPFS store, run migrations
- [ ] On first mount with empty `cells` table, bulk-import existing Y.Doc state via the registry's bootstrap path (idempotent, single-shot per project)
- [ ] On every Y.Doc change, the registry mirrors via Phase B
- [ ] Existing E2E tests (`editor/*.smoke.spec.ts`) still pass — editor behavior unchanged

**Phase C exit criteria:** every existing project, on first open in this branch, populates a complete local-store shadow copy. Editor flows continue to work via Y.Doc; local-store is silently kept fresh.

---

## Phase D — Replace `useCells` read path

Switch the synchronous read from Y.Doc to a polling/subscription cache fed by `LocalStore.query`. All downstream `CellData` consumers stay unchanged.

- [ ] `src/hooks/useCellsLocal.ts` — synchronous-shaped hook backed by an in-memory cache. The cache is rebuilt on each mirror update.
- [ ] Translation layer `src/lib/local-store/cell-row-to-cell-data.ts` — produces the legacy `CellData` shape from a `CellRow` plus joined data (label, status, etc.). Edit-keyed fields (validationStatus, etc.) join from the new tables.
- [ ] Replace `useCells` import in `ProjectWorkspace.tsx` with `useCellsLocal`
- [ ] Verify all `CellData`-consuming components (`EditorTable`, `VoiceBar`, `RuleDrawer`, `CellActionsMenu`, `HistoryDrawer`, `SelectionBar`, `StatusBar`, `CommentsDrawer`, `AudioRecordingModal`) keep working
- [ ] E2E: editor still renders cells, edit + save, audit overlay reflects state

**Phase D exit criteria:** Y.Doc is no longer the read source for cell data. Editing still flows through Y.Doc → mirror → local-store, but the UI reads from local-store.

---

## Phase E — New cell editor: plain text + placeholders

Replace TipTap-on-Y.XmlFragment with an editor that operates on `cells.translation_text` (plain text) + `cells.tag_dictionary` (placeholder metadata). This is the bulk of the editor rewrite.

- [ ] `src/components/codex-editor-v2/CellEditor.tsx` — the new editor primitive
  - [ ] Plain-text editing surface
  - [ ] Placeholder rendering as protected chips (drag/drop within cell, delete with backspace as a unit)
  - [ ] Tag dictionary mutations via outbox
  - [ ] Source/target placeholder validation: target's placeholder set must be a subset of source's
- [ ] Replace TipTap binding in `EditorTable.tsx` with the new editor
- [ ] Drop the `Y.XmlFragment` field from `CellData`
- [ ] Co-edit hook: when a cell has ≥2 focused users, spin up a transient `Y.Text` for live cursor relay (Phase G plumbing)
- [ ] Tests: unit + E2E for the new editor's golden flows (type, paste, delete placeholder, etc.)

**Phase E exit criteria:** Y.Doc no longer carries cell text; the editor operates directly on local-store with outbox-driven persistence.

---

## Phase F — Mirrors for the rest of `CellData`

Each subsystem gets its own mirror module + downstream wiring. Threads, comments, attachments, audio, validations, waivers, backtranslations.

- [ ] Threads + thread_messages mirror
- [ ] Cell_attachments mirror
- [ ] Validations mirror (writes `validation.signoff` mutations through the outbox)
- [ ] Waivers mirror
- [ ] Backtranslations mirror
- [ ] Audio timing mirror (uses existing `cell_media`)
- [ ] Each mirror has unit tests; each mutation kind has end-to-end coverage
- [ ] Existing UIs that depend on threads/comments/etc. updated to read from local-store

**Phase F exit criteria:** every `CellData` field has a defined home in local-store and a mirror that keeps it fresh. Y.Doc holds only ephemeral co-edit state.

---

## Phase G — Demote Y.Doc to ephemeral co-edit sugar

Y.Doc stops being a per-project persistent thing. The project DO stops persisting Y.Doc state to R2. Y.Text instances are spun up only when ≥2 clients focus the same cell, then torn down on quiesce.

- [ ] `sync-worker/`: drop `FileSync.onLoad` Y.Doc construction, snapshot/tail R2 writes, compaction alarm. Keep WS lifecycle, JWT verification, hibernation.
- [ ] DO becomes per-project, not per-file. Holds in-RAM presence + change-broadcast routing + transient Y.Texts.
- [ ] Add `broadcast({seq, changes, events})` RPC entrypoint called by frontier-server post-mutation
- [ ] Client: `useFileSync` retired; replaced by `useLiveSync` that subscribes to broadcasts and applies `applyChangeBatch` to local-store
- [ ] Co-edit Y.Text: spun up on second-focus, seeded from `cells.translation_text`, torn down on debounce-1s quiesce, final flush via mutation API
- [ ] R2 cleanup per `CLEANUP_POST_REFACTOR.md` §3.1 — delete legacy snapshot.bin / tail/ keys

**Phase G exit criteria:** Y.Doc has no persistent state. Single-user sessions never spin one up. Multi-user sessions on the same cell get live cursor relay.

---

## Phase H — Final cleanup

Per [CLEANUP_POST_REFACTOR.md](./CLEANUP_POST_REFACTOR.md). Delete dead code paths, retire `signaling/`, wipe legacy R2 keys, update [SYNC.md](./SYNC.md) to point at the new architecture.

- [ ] Delete `src/lib/sync/{cqrs-bridge,partyserver-provider,signaling-provider,bootstrap}.ts` (and others per cleanup §7.1)
- [ ] Delete `signaling/` directory; decommission deployed Worker
- [ ] Wipe `codex-db` and re-migrate
- [ ] Wipe legacy R2 keys (`projects/*/files/*/snapshot.bin` etc.)
- [ ] Mark [SYNC.md](./SYNC.md) superseded; redirect to [DATA_PERSISTENCE_PLAN.md](./DATA_PERSISTENCE_PLAN.md)
- [ ] Verification checklist from [CLEANUP_POST_REFACTOR.md §11](./CLEANUP_POST_REFACTOR.md#11-verification-checklist)

**Phase H exit criteria:** branch ready to merge to `main`. Every box in the cleanup verification checklist is checked.

---

## Working principles

- **Phases are commits.** Each phase ends in one or more focused commits with green tests.
- **Schema before structure.** No phase changes a schema without first updating the plan doc and migration files.
- **No conflict models in code without a documented conflict policy.** Every mutation kind has an entry in the plan doc's mutation table before it ships in code.
- **Y.Doc is going away as truth, but stays as sugar.** Phase E removes Y.XmlFragment; Phase G removes persistent Y.Doc; co-edit Y.Text remains as ephemeral sugar.
- **Test gates.** Each phase adds unit tests for new modules and extends Playwright for any new user-visible flow. The smoke suite must stay green at every phase boundary.

---

## Open questions to resolve as we go

- **Editor placeholder ergonomics.** What happens when the user types `{` literally — escape vs autocomplete? (Phase E.)
- **Bootstrap from Y.Doc — what's the source of truth for currently-edited cells?** A user might have unflushed Y.Doc state when we mount. The mirror needs to win, not the empty local-store. (Phase C.)
- **Validation status display when version moved.** Per the second PM's note: render staleness honestly ("validated at v3, current is v4"). UI work in Phase F.
- **Outbox kinds vs endpoints.** Do we add an explicit `kind` column, or keep it implicit in `endpoint`? Phase F decision; doesn't block earlier phases.
