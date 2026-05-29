// The editor's Audio-lens left rail: the CAST STUDIO. This is where you craft
// the project's character voices. A show translating its subtitles often has
// only ONE voice actor; "Cast" is how that single actor becomes MANY distinct
// characters — record/generate a take, turn it into a named character, then
// reuse that character across many lines.
//
// Per-cell controls (which character voices a line, generate, play, "make a
// character from this voice") now live INSIDE each cell's source column in
// Audio mode (see CellVoicePanel), so this rail is purely the cast roster +
// editor (VoiceLibraryPanel) plus the "make a character from existing audio"
// dialog. The clone dialog's open state is owned by the host so the per-cell
// "Make a character" control can drive the same dialog.

import { useState } from "react"
import { UserPlus } from "lucide-react"
import { Button } from "@/components/ui/button"
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
  targetLanguage?: string
  fileId?: string | null
  /** Host-owned clone dialog state so the per-cell "Make a character" control
   *  can open the same dialog seeded to a specific cell's take. */
  cloneOpen: boolean
  onCloneOpenChange: (open: boolean) => void
  /** Cell whose take seeds the dialog (null = manual pick from the roster). */
  cloneSeedCellId?: string | null
}

export function VoiceSidebar({
  cells, project, projectId, tts, session, username,
  targetLanguage, fileId, cloneOpen, onCloneOpenChange, cloneSeedCellId,
}: VoiceSidebarProps) {
  // `project` and `username` are part of the rail's contract (the studio is
  // project-scoped) but the cast editor reads everything it needs off `tts`.
  void project
  void username

  // The active cast member: the library's highlighted/selected character.
  const [activeVoiceId, setActiveVoiceId] = useState(tts.defaultVoiceId)

  // getVoiceLibrary always returns at least the presets, so settings being
  // mid-hydration is fine — the dialog just needs the resolved list.
  const settings = tts.settings ?? {
    provider: "gemini" as const,
    voices: tts.voices,
    defaultVoiceId: tts.defaultVoiceId,
    castAssignments: {},
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      {/* Make a character from any existing take (recorded or generated). The
          per-cell control opens this same dialog pre-seeded to one line. */}
      <Button
        variant="default"
        size="sm"
        className="h-8 justify-start"
        onClick={() => onCloneOpenChange(true)}
        title="Turn an existing take into a reusable Cast character"
      >
        <UserPlus className="mr-1.5 h-3.5 w-3.5" />
        Make a character
      </Button>

      {/* The full cast roster + editor. It was a w-96 drawer; in the w-64 rail
          it scrolls and clamps its width so nothing overflows horizontally. */}
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
        onClose={() => onCloneOpenChange(false)}
        cells={cells}
        settings={settings}
        projectId={projectId}
        session={session}
        onSave={tts.saveTts}
        seedCellId={cloneSeedCellId}
      />
    </div>
  )
}
