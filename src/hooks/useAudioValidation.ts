// AQU-490: casting an audio vote, for the surfaces that are not the gutter.
//
// The gutter builds this inline because it already holds every piece (scope
// guards, the lane, the commit callback). The other four — the take block, the
// recorder's take list, the timeline chip and the voice panel — hold a project,
// a cell and a username and nothing else, and four copies of the same emit is
// four chances for one of them to forget the role guard.
import { useCallback, useMemo } from "react"
import type { ProjectRecord } from "@/lib/parsers/types"
import { canPerform } from "@/lib/sync/role-policy"
import { emitCellAudioUnvalidate, emitCellAudioValidate } from "@/lib/sync/events-emit"
import { useI18n } from "@/lib/i18n/I18nProvider"
import {
  audioBlockedReason,
  audioEntryFromCell,
  audioValidationTakes,
  type CellLikeAudio,
} from "@/lib/audio/audio-validation-permissions"
import type { AudioValidationTake } from "@/components/cell/AudioValidationControl"
import { readValidationCountAudio } from "@/lib/progress/read-validation-count"

export interface UseAudioValidation {
  /** Every selected dub take on the cell, with the project's policy applied. */
  takesFor: (cell: CellLikeAudio | undefined) => AudioValidationTake[]
  /** Just the one take a per-take surface is showing. */
  takeFor: (cell: CellLikeAudio | undefined, audioId: string | null | undefined) => AudioValidationTake[]
  onValidationChange: (audioId: string, validated: boolean) => Promise<boolean>
  validationRequirement: number
  canValidate: boolean
}

export function useAudioValidation(opts: {
  project: ProjectRecord
  fileId: string
  cellId: string
  username: string
  /** Called after a vote lands, so the surface can refetch. */
  onCommitted?: (cellId: string) => void | Promise<void>
}): UseAudioValidation {
  const { project, fileId, cellId, username, onCommitted } = opts
  const { t } = useI18n()
  const roleLevel = project.syncRole?.level ?? null

  const reason = useMemo(() => audioBlockedReason(t), [t])

  const takesFor = useCallback(
    (cell: CellLikeAudio | undefined) =>
      audioValidationTakes(audioEntryFromCell(cell), project, { roleLevel, username }, reason),
    [project, roleLevel, username, reason],
  )

  const takeFor = useCallback(
    (cell: CellLikeAudio | undefined, audioId: string | null | undefined) => {
      if (!audioId) return []
      return takesFor(cell).filter((take) => take.audioId === audioId)
    },
    [takesFor],
  )

  const onValidationChange = useCallback(async (audioId: string, validated: boolean) => {
    const kind = validated ? "cell.audio.validate" : "cell.audio.unvalidate"
    // The same defensive guard the text path keeps: the control is already
    // muted for a role that cannot vote, but a keyboard or programmatic
    // trigger reaches here too, and a guaranteed 403 must not enter the outbox.
    if (!canPerform(kind, roleLevel)) {
      console.warn("[audio-validate] aborting: role too low for", kind)
      return false
    }
    try {
      const emit = validated ? emitCellAudioValidate : emitCellAudioUnvalidate
      await emit({ projectId: project.id, fileId, cellId, audioId, author: username })
      await onCommitted?.(cellId)
      return true
    } catch (error) {
      console.error("[audio-validate] emit failed", error)
      return false
    }
  }, [project.id, fileId, cellId, username, roleLevel, onCommitted])

  return {
    takesFor,
    takeFor,
    onValidationChange,
    validationRequirement: readValidationCountAudio(project),
    canValidate: canPerform("cell.audio.validate", roleLevel),
  }
}
