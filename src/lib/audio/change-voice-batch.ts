// "Change voice of existing audio" — the project-wide Change voice (AQU-1109).
//
// Converts every cell's selected take into that cell's assigned cast voice with
// Seed-VC. Nothing is synthesized from text. Cells that can't or needn't change
// are skipped and counted so the caller can say why: no take to convert, an
// assigned voice with no reference clip (stock voices are out of scope for v1),
// or a take already converted from that voice's CURRENT reference clip at the
// chosen quality. A new reference clip, or a different quality, is redone.
// A selected take that a voice is using as its reference clip is left alone.
//
// Runs through the shared batch runner, so the AudioBulkProgressBanner shows
// progress and can cancel it like the other bulk audio actions.

import type { CellData } from "@/hooks/useCells"
import type { FrontierSession } from "@/lib/frontier/types"
import type { ProjectTtsSettings, Voice } from "@/lib/parsers/types"
import { runBatch } from "./batch-audio"
import { changeCellVoice, changeVoiceBlocker, changeVoiceSourceTake, type ChangeVoiceBlocker } from "./change-voice"
import { getTtsStatus, ttsStatusKey } from "./tts"
import { getVoiceLibrary, resolveCastVoice } from "./voices"
import { changeVoiceDiffusionSteps } from "@/lib/store/change-voice-quality"

export interface ChangeVoiceTarget {
  cell: CellData
  voice: Voice
}

export type ChangeVoiceSkipCounts = Record<ChangeVoiceBlocker | "busy" | "voice-reference", number>

/**
 * The key the voice library stores when a clone was lifted from a line take:
 * `${cellId}:recorded` or `${cellId}:generated`.
 */
function cloneTakeKey(cell: CellData, audioId: string): string {
  const slot = audioId === cell.selectedGeneratedVoiceAudioId && audioId !== cell.selectedAudioId
    ? "generated"
    : "recorded"
  return `${cell.id}:${slot}`
}

/** Some voice in the library is using this cell's selected take as its reference clip. */
function takeUsedByVoice(cell: CellData, settings: ProjectTtsSettings | undefined): boolean {
  const take = changeVoiceSourceTake(cell)
  if (!take) return false
  const key = cloneTakeKey(cell, take.audioId)
  return getVoiceLibrary(settings).some((voice) =>
    voice.referenceTakeKey === key || voice.referenceAudioId === take.audioId,
  )
}

export interface ChangeVoicePlan {
  targets: ChangeVoiceTarget[]
  skipped: ChangeVoiceSkipCounts
}

export function planChangeVoiceAll(
  cells: CellData[],
  settings: ProjectTtsSettings | undefined,
  /** When set, a take already in this voice is redone if its reference clip or
   *  its quality differs. Omitted, any quality of the current clip counts as done. */
  diffusionSteps?: number,
): ChangeVoicePlan {
  const skipped: ChangeVoiceSkipCounts = { "no-take": 0, "not-cloned": 0, "up-to-date": 0, busy: 0, "voice-reference": 0 }
  const targets: ChangeVoiceTarget[] = []
  for (const cell of cells) {
    if (takeUsedByVoice(cell, settings)) {
      skipped["voice-reference"]++
      continue
    }
    const voice = resolveCastVoice(settings, cell.id)
    const blocker = changeVoiceBlocker(cell, voice, diffusionSteps)
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
  settings: ProjectTtsSettings | undefined
  session: FrontierSession | null
  author: string
  /** Seed-VC diffusion steps. Defaults to the device's Change voice quality. */
  diffusionSteps?: number
}

export interface ChangeVoiceAllResult {
  converted: number
  failed: number
  skipped: ChangeVoiceSkipCounts
}

export async function runChangeVoiceAll(args: ChangeVoiceAllArgs): Promise<ChangeVoiceAllResult> {
  const diffusionSteps = args.diffusionSteps ?? changeVoiceDiffusionSteps()
  const { targets, skipped } = planChangeVoiceAll(args.cells, args.settings, diffusionSteps)
  const result: ChangeVoiceAllResult = { converted: 0, failed: 0, skipped }
  if (targets.length === 0) return result

  _cancelFlag = false
  await runBatch(
    targets,
    async ({ cell, voice }) => {
      const ok = await changeCellVoice({
        projectId: args.projectId,
        cell,
        voice,
        session: args.session,
        author: args.author,
        diffusionSteps,
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
