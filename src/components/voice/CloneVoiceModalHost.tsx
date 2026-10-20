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
import { ROLE } from "@/lib/frontier/roles"
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
}: CloneVoiceModalHostProps) {
  const canEditVoices = roleLevel == null || roleLevel >= ROLE.MAINTAINER

  // AQU-2037: a library write merges into the PROJECT's voices, not the open
  // lane's — `tts.voices` is the lane view, and storing it would delete every
  // other lane's voices. The stored default rides along unchanged for the same
  // reason: `tts.defaultVoiceId` is this lane's resolved default, so writing it
  // back would overwrite another lane's starred voice. `saveTts` stamps the new
  // voice with the active lane on the way through.
  const saveVoice = (voice: Voice) => {
    if (!canEditVoices) return
    const next = upsertVoice(tts.allVoices, voice, tts.settings?.defaultVoiceId)
    void tts.saveTts({ voices: next.voices, defaultVoiceId: next.defaultVoiceId })
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
      initialMode="clone"
      seedCellId={seedCellId}
    />
  )
}
