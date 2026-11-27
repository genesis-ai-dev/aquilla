/**
 * Put the cells the interaction scenario types into back to one fixed text
 * before every pass — PERF-BACKLOG item 37.
 *
 * The scenario types into the same cells every run, and what it types is
 * added to what is there. After a dozen runs one cell held "Short edit 1"
 * fourteen times and the activate cell 729 characters. Taller rows mean fewer
 * rows in the virtualized window, so every render count that scales with the
 * rows on screen drifted down from run to run on an unchanged tree. Resetting
 * those cells to SETTLED_TEXT makes every pass start from the same fixture.
 *
 * SETTLED_TEXT is not empty on purpose: the budgets describe an edit, not a
 * first translation of an empty cell (see `ensureFixture` in interaction.ts).
 * Each reset is also validated, as the editor validates a human edit
 * (EditorTable's auto-validate-on-edit): a reset cell left unvalidated made
 * the scenario's next commit change the validated set, which refetches cell
 * confidence and re-renders the workspace (commit rowRenders 11 → 19).
 */

import { v7 as uuidv7 } from "uuid"
import { devLogin, mintSyncToken, postEvents, request, type PerfTarget, type RawEventInput } from "./client"
import type { BigBibleHandle } from "./fixture-handle"

/** What the scenario types: the 40 keystrokes of the typing phase, and editTab's short edits. */
export const TYPED_SENTENCE = "A sentence of forty characters to type. "
export const shortEdit = (i: number): string => `Short edit ${i} `
/** A cell holding any of these was typed into by a run. */
const SCENARIO_MARKERS = [TYPED_SENTENCE.trim(), shortEdit(0).replace(/\d+ $/, "")]
export const SETTLED_TEXT = "Settled text. "
/** `src/lib/sync/outbox-types.ts` OUTBOX_SCHEMA_VERSION. */
const SCHEMA_VERSION = 1

export interface TargetCell {
  cellId: string
  value: string
  eventId: string
  sourceEventId?: string | null
  laneId?: string | null
  targetLang?: string | null
}

/**
 * For every cell a previous run left text in: the commit that puts it back, chained on its
 * head, then the validation of that commit.
 */
export function resetEvents(cells: readonly TargetCell[], meta: { projectId: string; fileId: string; author: string; now: number }): RawEventInput[] {
  return cells
    .filter((cell) => cell.value !== SETTLED_TEXT && SCENARIO_MARKERS.some((marker) => cell.value.includes(marker)))
    .flatMap((cell) => {
      const lane = {
        ...(cell.laneId ? { laneId: cell.laneId } : {}),
        ...(cell.targetLang ? { targetLang: cell.targetLang } : {}),
      }
      const envelope = {
        schemaVersion: SCHEMA_VERSION,
        projectId: meta.projectId,
        fileId: meta.fileId,
        cellId: cell.cellId,
        author: meta.author,
        clientTs: meta.now,
      }
      const commitId = uuidv7()
      return [
        {
          ...envelope,
          id: commitId,
          kind: "target.cell.commit",
          parentId: cell.eventId,
          payload: {
            value: SETTLED_TEXT,
            valueHtml: `<p>${SETTLED_TEXT}</p>`,
            ...(cell.sourceEventId ? { sourceEventId: cell.sourceEventId } : {}),
            ...lane,
          },
        },
        // Additive, so no parent (events-emit.ts emitCellValidate).
        { ...envelope, id: uuidv7(), kind: "cell.validate", parentId: null, payload: { editEventId: commitId, ...lane } },
      ]
    })
}

/** Reset the scenario's cells in the file the scenario opens. Returns how many were reset. */
export async function resetScenarioCells(target: PerfTarget, handle: BigBibleHandle): Promise<number> {
  const file = handle.files[0]
  const session = await devLogin(target)
  const token = await mintSyncToken(target, session.jwt, handle.projectId, file.id)
  // 400 cells over 2 files: the scenario's file fits one page.
  const { body } = await request<{ cells: Array<TargetCell & { side: string }> }>(
    `${target.syncBase}/api/v1/projects/${encodeURIComponent(handle.projectId)}/files/${encodeURIComponent(file.id)}/cells?limit=500&side=target`,
    "read the scenario's cells",
    { token },
  )
  const events = resetEvents(body.cells.filter((cell) => cell.side === "target"), {
    projectId: handle.projectId,
    fileId: file.id,
    author: session.username,
    now: Date.now(),
  })
  if (events.length === 0) return 0
  const result = await postEvents(target, token, events)
  if (result.stale && result.stale.length > 0) {
    throw new Error(`resetting the scenario's cells: ${result.stale.length} of ${events.length} events were stale`)
  }
  return events.filter((event) => event.kind === "target.cell.commit").length
}
