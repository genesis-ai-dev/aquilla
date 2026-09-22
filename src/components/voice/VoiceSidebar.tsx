// The editor's Audio-lens left rail: the CAST STUDIO. A show translating its
// subtitles often has only ONE voice actor; "Cast" is how that single actor
// becomes MANY distinct characters. This rail is the calm cast roster
// (VoiceLibraryPanel). Crafting a voice from the panel's "New voice" button
// still happens inside that roster's modal. Cloning from a source cell's
// audio controls is hosted at the workspace root (CloneVoiceModalHost) so
// the modal opens in place without the Voices tab having to be mounted.

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
  targetLanguage?: string
  fileId?: string | null
}

export function VoiceSidebar({
  project, projectId, tts, session, username,
  targetLanguage, fileId, cells,
}: VoiceSidebarProps) {
  // `username` is part of the rail's contract (the studio is project-scoped)
  // but the cast roster reads everything else it needs off `tts`.
  // AQU-365: `project.syncRole?.level` gates character CRUD in VoiceLibraryPanel.
  void username

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-hidden rounded-xl border bg-background">
        <div className="h-full w-full overflow-x-hidden">
          <VoiceLibraryPanel
            settings={tts.settings}
            onSettingsChange={tts.saveTts}
            targetLanguage={targetLanguage ?? project.targetLanguage}
            targetLanes={project.targetLanes}
            archivedLanes={project.archivedLanes}
            projectId={projectId}
            fileId={fileId}
            session={session}
            castStats={tts.castStats}
            cells={cells}
            roleLevel={project.syncRole?.level ?? null}
          />
        </div>
      </div>
    </div>
  )
}
