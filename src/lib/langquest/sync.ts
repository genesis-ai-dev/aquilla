// Pull a linked LangQuest language into its Aquilla project.
//
// The first import and every later update are the same run: with no feed
// cursor yet (a new link, or LangQuest answered 410 for an old one) it lists
// every passage; otherwise it reads the change feed from the cursor and
// re-reads only the passages it names. Either way planSync (./plan.ts) diffs
// what it read against the project's passage→cell map, the plan is applied as
// ordinary import/events traffic, and only then is the map advanced — so a run
// that dies halfway repeats harmlessly (deterministic ids) instead of skipping.
//
// Passages are applied a page at a time because LangQuest's audio links expire
// ten minutes after they are signed (docs/agent-api.md).

import type { BulkUploadArgs } from "../sync/bulk-import"
import type { BulkPostEventsResult } from "../sync/bulk-events"
import type { CqrsRawEvent } from "../sync/outbox-types"
import { buildRawEvent } from "../sync/events-emit"
import type { UploadCellAudioArgs } from "../audio/upload"
import { buildFrontierAudioUrl } from "../audio/upload"
import { langquestAudioId, langquestEventId, planSync, type SyncPlan } from "./plan"
import type { KnownPassage, LangQuestChange, LangQuestPassage } from "./types"
import { LangQuestLinkError } from "./api"

export interface LangQuestSyncDeps {
  projectId: string
  languageId: string
  author: string
  /** The target lane the recordings perform (the LangQuest language's code). */
  targetLang: string
  fetchState: () => Promise<{ cursor: string | null; passages: KnownPassage[] }>
  saveState: (body: {
    upserts?: KnownPassage[]
    removed?: string[]
    cursor?: string | null
    outcome?: { error: string | null }
  }) => Promise<unknown>
  fetchChanges: (after: string | null) => Promise<{ changes: LangQuestChange[]; cursor: string; more: boolean }>
  fetchPassages: (opts: { after?: string | null; unitIds?: string[] }) => Promise<{
    passages: LangQuestPassage[]
    nextAfter: string | null
  }>
  fetchAudio: (url: string) => Promise<Blob>
  uploadSource: (args: BulkUploadArgs) => Promise<unknown>
  postEvents: (args: { events: CqrsRawEvent[]; getToken: (fileId: string) => Promise<string | null> }) => Promise<BulkPostEventsResult>
  uploadAudio: (args: UploadCellAudioArgs) => Promise<unknown>
  getToken: (fileId: string) => Promise<string | null>
  onProgress?: (p: LangQuestSyncProgress) => void
  signal?: AbortSignal
}

export interface LangQuestSyncProgress {
  phase: "listing" | "changes" | "audio"
  passagesRead: number
  takesAttached: number
}

export interface LangQuestSyncResult {
  mode: "full" | "changes"
  passagesRead: number
  cellsCreated: number
  takesAttached: number
  cellsRemoved: number
}

const UNIT_BATCH = 100

export async function syncLangQuest(deps: LangQuestSyncDeps): Promise<LangQuestSyncResult> {
  const state = await deps.fetchState()
  const known = new Map(state.passages.map((p) => [p.unitId, p]))
  const result: LangQuestSyncResult = { mode: "changes", passagesRead: 0, cellsCreated: 0, takesAttached: 0, cellsRemoved: 0 }

  try {
    if (state.cursor != null) {
      try {
        await followFeed(deps, state.cursor, known, result)
      } catch (err) {
        if (!(err instanceof LangQuestLinkError && err.cursorExpired)) throw err
        await listEverything(deps, known, result)
      }
    } else {
      await listEverything(deps, known, result)
    }
  } catch (err) {
    await deps
      .saveState({ outcome: { error: err instanceof Error ? err.message.slice(0, 1000) : String(err) } })
      .catch(() => {})
    throw err
  }
  await deps.saveState({ outcome: { error: null } })
  return result
}

/** No usable cursor: list every passage, then start the feed from where the listing began. */
async function listEverything(deps: LangQuestSyncDeps, known: Map<string, KnownPassage>, result: LangQuestSyncResult) {
  result.mode = "full"
  // Take the feed's head BEFORE listing, so a change made while the listing
  // runs is read again next time rather than lost between the two.
  const head = (await deps.fetchChanges(null)).cursor
  const seen = new Set<string>()
  let after: string | null = null
  do {
    throwIfAborted(deps.signal)
    const page = await deps.fetchPassages({ after })
    for (const p of page.passages) seen.add(p.unitId)
    result.passagesRead += page.passages.length
    deps.onProgress?.({ phase: "listing", passagesRead: result.passagesRead, takesAttached: result.takesAttached })
    await applyPassages(deps, known, page.passages, [], result)
    after = page.nextAfter
  } while (after)
  const gone = [...known.keys()].filter((unitId) => !seen.has(unitId))
  if (gone.length > 0) await applyPassages(deps, known, [], gone, result)
  await deps.saveState({ cursor: head })
}

/** Read the change feed from `cursor` and re-read the passages it names. */
async function followFeed(
  deps: LangQuestSyncDeps,
  cursor: string,
  known: Map<string, KnownPassage>,
  result: LangQuestSyncResult,
) {
  const changed = new Set<string>()
  const deleted = new Set<string>()
  let next = cursor
  for (;;) {
    throwIfAborted(deps.signal)
    const page = await deps.fetchChanges(next)
    for (const change of page.changes) {
      // The feed is oldest-first: a later change to the same unit decides.
      if (change.type === "unit.deleted") {
        deleted.add(change.unitId)
        changed.delete(change.unitId)
      } else {
        changed.add(change.unitId)
        deleted.delete(change.unitId)
      }
    }
    next = page.cursor
    if (!page.more) break
  }
  const ids = [...changed]
  for (let i = 0; i < ids.length; i += UNIT_BATCH) {
    throwIfAborted(deps.signal)
    const batch = ids.slice(i, i + UNIT_BATCH)
    const { passages } = await deps.fetchPassages({ unitIds: batch })
    result.passagesRead += passages.length
    deps.onProgress?.({ phase: "changes", passagesRead: result.passagesRead, takesAttached: result.takesAttached })
    // A named unit LangQuest no longer returns is one this token cannot see any more.
    const returned = new Set(passages.map((p) => p.unitId))
    for (const unitId of batch) if (!returned.has(unitId)) deleted.add(unitId)
    await applyPassages(deps, known, passages, [], result)
  }
  if (deleted.size > 0) await applyPassages(deps, known, [], [...deleted], result)
  await deps.saveState({ cursor: next })
}

async function applyPassages(
  deps: LangQuestSyncDeps,
  known: Map<string, KnownPassage>,
  passages: LangQuestPassage[],
  deletedUnitIds: string[],
  result: LangQuestSyncResult,
) {
  const plan = planSync({
    projectId: deps.projectId,
    languageId: deps.languageId,
    known: [...known.values()],
    passages,
    deletedUnitIds,
  })
  await applyPlan(deps, plan, result)
  if (plan.rows.length > 0 || plan.removed.length > 0) {
    await deps.saveState({ upserts: plan.rows, removed: plan.removed.map((r) => r.unitId) })
  }
  for (const row of plan.rows) known.set(row.unitId, row)
  for (const row of plan.removed) known.delete(row.unitId)
}

async function applyPlan(deps: LangQuestSyncDeps, plan: SyncPlan, result: LangQuestSyncResult) {
  const { projectId, author } = deps

  // 1. Books Aquilla has no file for: one import each, cells chained in order.
  for (const file of plan.newFiles) {
    throwIfAborted(deps.signal)
    await deps.uploadSource({
      projectId,
      fileId: file.fileId,
      file: { id: file.fileId, name: file.name, fileType: "langquest", importFormat: "langquest", parserVersion: "builtin:langquest@1" },
      cells: file.cells.map((c) => ({
        id: c.eventId,
        cellId: c.cellId,
        anchorCellId: c.anchorCellId,
        value: c.value,
        ...(c.canonicalRef ? { canonicalRef: c.canonicalRef } : {}),
        metadata: c.metadata,
      })),
      getToken: deps.getToken,
      ...(deps.signal ? { signal: deps.signal } : {}),
    })
    result.cellsCreated += file.cells.length
  }

  // 2. New passages in books that already have a file, and passages gone from LangQuest.
  const cellEvents: CqrsRawEvent[] = [
    ...plan.newCells.map(
      (c) =>
        buildRawEvent({
          kind: "source.cell.create",
          projectId,
          fileId: c.fileId,
          cellId: c.cellId,
          parentId: null,
          author,
          id: c.eventId,
          payload: {
            cellId: c.cellId,
            anchorCellId: c.anchorCellId,
            value: c.value,
            ...(c.canonicalRef ? { canonicalRef: c.canonicalRef } : {}),
            metadata: c.metadata,
          },
        }) as CqrsRawEvent,
    ),
    ...plan.removed.map(
      (r) =>
        buildRawEvent({
          kind: "source.cell.delete",
          projectId,
          fileId: r.fileId,
          cellId: r.cellId,
          parentId: null,
          author,
          id: langquestEventId(projectId, r.unitId, "delete", r.cellId),
          payload: {},
        }) as CqrsRawEvent,
    ),
  ]
  await postAll(deps, cellEvents)
  result.cellsCreated += plan.newCells.length
  result.cellsRemoved += plan.removed.length

  // 3. Each new version: its cards to R2, then one take cut into ordered pieces.
  for (const take of plan.takes) {
    throwIfAborted(deps.signal)
    const events: CqrsRawEvent[] = []
    let rootAudioId: string | null = null
    for (const [i, card] of take.cards.entries()) {
      const audioId = langquestAudioId(take.cellId, card)
      const blob = await deps.fetchAudio(card.url)
      await deps.uploadAudio({
        projectId,
        fileId: take.fileId,
        audioId,
        ext: card.format,
        blob,
        getSyncToken: (_projectId, fileId) => deps.getToken(fileId),
        ...(deps.signal ? { signal: deps.signal } : {}),
      })
      events.push(
        buildRawEvent({
          kind: "cell.audio.attach",
          projectId,
          fileId: take.fileId,
          cellId: take.cellId,
          parentId: null,
          author,
          id: langquestEventId(projectId, take.unitId, "take", take.takeId, String(i)),
          payload: {
            audioId,
            url: buildFrontierAudioUrl(audioId, card.format),
            slot: "recording",
            mimeType: card.format === "wav" ? "audio/wav" : "audio/mp4",
            durationMs: Math.round(card.durationMs),
            label: `LangQuest v${take.versionN}`,
            role: "dub",
            targetLang: deps.targetLang,
            ...(rootAudioId ? { pieceOf: rootAudioId } : {}),
          },
        }) as CqrsRawEvent,
      )
      rootAudioId ??= audioId
    }
    await postAll(deps, events)
    result.takesAttached++
    deps.onProgress?.({ phase: "audio", passagesRead: result.passagesRead, takesAttached: result.takesAttached })
  }
}

async function postAll(deps: LangQuestSyncDeps, events: CqrsRawEvent[]) {
  if (events.length === 0) return
  const outcome = await deps.postEvents({ events, getToken: deps.getToken })
  // A refusal or a stale head means part of the plan did not land; the map
  // must not advance past it, or the next run would never retry it.
  const notApplied = outcome.rejected.length + outcome.stale.length
  if (notApplied > 0) throw new Error(`${notApplied} LangQuest change(s) were not applied`)
}

function throwIfAborted(signal: AbortSignal | undefined) {
  if (signal?.aborted) throw new Error("LangQuest sync cancelled")
}
