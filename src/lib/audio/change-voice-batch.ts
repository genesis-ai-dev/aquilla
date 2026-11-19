// "Change voice of existing audio" — the project-wide Change voice (AQU-1109).
//
// Converts every cell's selected take into that cell's assigned cast voice with
// the voice forge (RVC). Nothing is synthesized from text. Cells that can't or
// needn't change are skipped and counted so the caller can say why: no take to
// convert, an assigned voice with no trained model (only character voices and
// trained voices convert), a take already converted into that voice, or
// (AQU-2499) a recording other lines share.
//
// Runs through the shared batch runner, so the AudioBulkProgressBanner shows
// progress and can cancel it like the other bulk audio actions.

import type { CellData } from "@/hooks/useCells"
import type { FrontierSession } from "@/lib/frontier/types"
import type { ProjectTtsSettings, Voice } from "@/lib/parsers/types"
import { runBatchJobs } from "./batch-audio"
import { changeCellVoice, changeVoiceBlocker, recordingLinesOf, type ChangeVoiceBlocker } from "./change-voice"
import { getTtsStatus, ttsStatusKey } from "./tts"
import { resolveCastVoice } from "./voices"

export interface ChangeVoiceTarget {
  cell: CellData
  voice: Voice
}

export type ChangeVoiceSkipCounts = Record<ChangeVoiceBlocker | "busy", number>

export interface ChangeVoicePlan {
  targets: ChangeVoiceTarget[]
  skipped: ChangeVoiceSkipCounts
}

export function planChangeVoiceAll(
  cells: CellData[],
  /** The OPEN LANE's voices (AQU-2037) — which voice each line speaks with. */
  settings: ProjectTtsSettings | undefined,
): ChangeVoicePlan {
  const skipped: ChangeVoiceSkipCounts = { "no-take": 0, "not-trained": 0, "up-to-date": 0, shared: 0, busy: 0 }
  const targets: ChangeVoiceTarget[] = []
  // AQU-2499 (review, Nov 9): a line whose recording other lines share is
  // skipped and counted, not converted whole once per line.
  const lines = recordingLinesOf(cells.map((c) => [c.id, c] as const))
  for (const cell of cells) {
    const voice = resolveCastVoice(settings, cell)
    const blocker = changeVoiceBlocker(cell, voice, undefined, lines)
    if (blocker) {
      skipped[blocker]++
      continue
    }
    const st = getTtsStatus(ttsStatusKey(cell.id))
    if (st.kind === "loading" || st.kind === "synthesizing") {
      skipped.busy++
      continue
    }
    targets.push({ cell, voice })
  }
  return { targets, skipped }
}

let _cancelFlag = false

export function cancelBatchChangeVoice() {
  _cancelFlag = true
}

export interface ChangeVoiceAllArgs {
  projectId: string
  cells: CellData[]
  /** The OPEN LANE's voices (AQU-2037). */
  settings: ProjectTtsSettings | undefined
  session: FrontierSession | null
  author: string
  /** AQU-1462: lane the member is working in. Omitted for the default lane. */
  targetLang?: string
}

export interface ChangeVoiceAllResult {
  converted: number
  failed: number
  skipped: ChangeVoiceSkipCounts
}

export async function runChangeVoiceAll(args: ChangeVoiceAllArgs): Promise<ChangeVoiceAllResult> {
  const { targets, skipped } = planChangeVoiceAll(args.cells, args.settings)
  const result: ChangeVoiceAllResult = { converted: 0, failed: 0, skipped }
  if (targets.length === 0) return result

  _cancelFlag = false
  await runBatchJobs(
    targets,
    async ({ cell, voice }) => {
      const ok = await changeCellVoice({
        projectId: args.projectId,
        cell,
        voice,
        session: args.session,
        author: args.author,
        // AQU-2499 (review, Nov 9): each new take goes in the open language,
        // as a one-line Change voice does; without it a second language's
        // takes were filed under the default one.
        ...(args.targetLang ? { targetLang: args.targetLang } : {}),
      })
      if (ok) result.converted++
      else result.failed++
    },
    {
      kind: "changeVoice",
      isCancelled: () => _cancelFlag,
      onItemDone: () => { /* per-cell badge handles its own state */ },
    },
  )
  return result
}
