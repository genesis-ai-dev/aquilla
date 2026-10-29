// Host for the in-cell "Clone voice" entry point (AQU-1001).
//
// NewVoiceModal used to live only inside VoiceLibraryPanel, which LeftDock
// mounts solely while the Voices tab is active. Clicking Clone on a source
// cell therefore did nothing until the user opened that tab. This host sits
// at the workspace root so the same modal opens in place, seeded to the
// line's take, without switching the dock.

import { NewVoiceModal } from "./NewVoiceModal"
import { upsertVoice } from "@/lib/audio/voices"
import { resolveTtsProvider } from "@/lib/audio/tts-providers"
import { canManageVoices } from "@/lib/audio/voice-permission"
import type { ProjectTtsApi } from "@/hooks/useProjectTts"
import type { CellData } from "@/hooks/useCells"
import type { FrontierSession } from "@/lib/frontier/types"
import type { Voice } from "@/lib/parsers/types"

export interface CloneVoiceModalHostProps {
  open: boolean
  onClose: () => void
  /** Cell whose take is highlighted as the clone source. */
  seedCellId: string | null
  tts: ProjectTtsApi
  projectId: string
  fileId?: string | null
  session: FrontierSession | null
  targetLanguage?: string
  targetLanes?: string[]
  archivedLanes?: string[]
  cells: CellData[]
  /** Project role level; same maintainer floor as VoiceLibraryPanel. */
  roleLevel?: number | null
  /** AQU-2041. Same switch as VoiceLibraryPanel. */
  leadsManageVoices?: boolean
  /** Which tab opens: "clone" (from a take) or "character" (Add a voice…). */
  initialMode?: "clone" | "character"
  /** After a NEW voice is saved. */
  onAdded?: (voice: Voice) => void
}

export function CloneVoiceModalHost({
  open,
  onClose,
  seedCellId,
  tts,
  projectId,
  fileId,
  session,
  targetLanguage,
  targetLanes,
  archivedLanes,
  cells,
  roleLevel,
  leadsManageVoices = false,
  initialMode = "clone",
  onAdded,
}: CloneVoiceModalHostProps) {
  const canEditVoices = canManageVoices(roleLevel, leadsManageVoices)

  // AQU-2037: a library write merges into the PROJECT's voices, not the open
  // lane's — `tts.voices` is the lane view, and storing it would delete every
  // other lane's voices. `saveTts` stamps the new voice with the active lane on
  // the way through.
  // AQU-2038: a `defaultVoiceId` in the patch is the ACTIVE LANE's star, so the
  // default riding along is the lane's own (`tts.laneSettings`). Passing the
  // project-wide one through here would move the lane's star back onto it.
  const saveVoice = (voice: Voice) => {
    if (!canEditVoices) return
    const next = upsertVoice(tts.allVoices, voice, tts.laneSettings?.defaultVoiceId)
    void tts.saveTts({ voices: next.voices, defaultVoiceId: next.defaultVoiceId })
    onAdded?.(voice)
  }

  return (
    <NewVoiceModal
      open={open}
      onClose={onClose}
      voice={null}
      provider={resolveTtsProvider(tts.settings)}
      targetLanguage={targetLanguage}
      targetLanes={targetLanes}
      archivedLanes={archivedLanes}
      isDefault={false}
      paletteIndex={tts.allVoices.length}
      projectId={projectId}
      fileId={fileId}
      session={session}
      cells={cells}
      onSave={saveVoice}
      initialMode={initialMode}
      seedCellId={initialMode === "clone" ? seedCellId : null}
      existingVoices={tts.allVoices}
    />
  )
}
