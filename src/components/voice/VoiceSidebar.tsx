// The editor's Audio-lens left rail: the whole voice setup consolidated into
// the w-64 app rail. Composes the compact VoiceCockpit (active profile,
// generate, play, clone/record entries), the reused full cast library
// (VoiceLibraryPanel), and the clone-from-existing-audio dialog. Replaces the
// scattered audio chrome (transport bar, cast drawer, cast-assign bar) that
// used to live around the editor.

import { useState } from "react"
import { VoiceCockpit } from "./VoiceCockpit"
import { CloneVoiceDialog } from "./CloneVoiceDialog"
import { VoiceLibraryPanel } from "../VoiceLibraryPanel"
import type { ProjectTtsApi } from "@/hooks/useProjectTts"
import type { CellData } from "@/hooks/useCells"
import type { FrontierSession } from "@/lib/frontier/types"
import type { ProjectRecord as Project } from "@/lib/parsers/types"

interface VoiceSidebarProps {
  cells: CellData[]
  project: Project
  projectId: string
  /** The useProjectTts return — settings, voices, writers, cast stats. */
  tts: ProjectTtsApi
  session: FrontierSession | null
  username: string
  selectedCellIds: string[]
  onAfterGenerate: () => void
  targetLanguage?: string
  fileId?: string | null
  /** Open the booth recorder (mirrors VoiceTransportBar's record entry). */
  onRecord: () => void
}

export function VoiceSidebar({
  cells, project, projectId, tts, session, username, selectedCellIds,
  onAfterGenerate, targetLanguage, fileId, onRecord,
}: VoiceSidebarProps) {
  // The active cast member: the cockpit's assign target + the library's
  // highlighted/selected voice. Seeded from the project's default voice.
  const [activeVoiceId, setActiveVoiceId] = useState(tts.defaultVoiceId)
  const [cloneOpen, setCloneOpen] = useState(false)

  // getVoiceLibrary always returns at least the presets, so settings being
  // mid-hydration is fine — the cockpit just needs the resolved list.
  const settings = tts.settings ?? {
    provider: "gemini" as const,
    voices: tts.voices,
    defaultVoiceId: tts.defaultVoiceId,
    castAssignments: {},
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <VoiceCockpit
        cells={cells}
        project={project}
        projectId={projectId}
        settings={settings}
        voices={tts.voices}
        activeVoiceId={activeVoiceId}
        selectedCellIds={selectedCellIds}
        session={session}
        username={username}
        onAfterGenerate={onAfterGenerate}
        onAssignToSelection={(voiceId) => tts.assignCells(selectedCellIds, voiceId)}
        onRequestClone={() => setCloneOpen(true)}
        onRecord={onRecord}
      />

      {/* The full cast library. It was a w-96 drawer; in the w-64 rail it
          scrolls and clamps its width so nothing overflows horizontally. */}
      <div className="min-h-0 flex-1 overflow-hidden rounded-xl border bg-background">
        <div className="h-full w-full overflow-x-hidden">
          <VoiceLibraryPanel
            settings={tts.settings}
            onSettingsChange={tts.saveTts}
            targetLanguage={targetLanguage}
            projectId={projectId}
            fileId={fileId}
            session={session}
            castStats={tts.castStats}
            selectedVoiceId={activeVoiceId}
            onSelectVoice={setActiveVoiceId}
          />
        </div>
      </div>

      <CloneVoiceDialog
        open={cloneOpen}
        onClose={() => setCloneOpen(false)}
        cells={cells}
        settings={settings}
        projectId={projectId}
        session={session}
        onSave={tts.saveTts}
      />
    </div>
  )
}
