// The editor's Audio-lens left rail: the CAST STUDIO. A show translating its
// subtitles often has only ONE voice actor; "Cast" is how that single actor
// becomes MANY distinct characters. This rail is now purely the calm cast
// roster (VoiceLibraryPanel) — crafting/cloning a character happens inside the
// roster's NewVoiceModal, so there's no separate clone dialog or "make a
// character" button here anymore.
//
// The host still owns a "clone open + seed cell" signal (so the per-cell "+"
// can open the creator seeded to a specific line's take). We translate that
// host signal into a `seedSignal` bump the roster reacts to.

import { useEffect, useState } from "react"
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
  /** Host-owned "open the character creator" signal so the per-cell "+" can
   *  open the same creator seeded to a specific cell's take. */
  cloneOpen: boolean
  onCloneOpenChange: (open: boolean) => void
  /** Cell whose take seeds a brand-new character (null = manual pick). */
  cloneSeedCellId?: string | null
}

export function VoiceSidebar({
  project, projectId, tts, session, username,
  targetLanguage, fileId, cells, cloneOpen, onCloneOpenChange, cloneSeedCellId,
}: VoiceSidebarProps) {
  // `username` is part of the rail's contract (the studio is project-scoped)
  // but the cast roster reads everything else it needs off `tts`.
  // AQU-365: `project.syncRole?.level` gates character CRUD in VoiceLibraryPanel.
  void username

  // Translate the host's open/close clone signal into a monotonically rising
  // `seedSignal` the roster consumes to (re)open its NewVoiceModal seeded to a
  // take. On each rising edge of `cloneOpen` we bump the signal (a real state
  // update so the roster re-renders) and reset the host flag — the modal's own
  // lifecycle now lives in the roster, so the host flag is just an edge-trigger.
  const [seedSignal, setSeedSignal] = useState(0)
  useEffect(() => {
    if (!cloneOpen) return
    setSeedSignal((n) => n + 1)
    onCloneOpenChange(false)
  }, [cloneOpen, onCloneOpenChange])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
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
            cells={cells}
            seedCellId={cloneSeedCellId}
            seedSignal={seedSignal}
            roleLevel={project.syncRole?.level ?? null}
          />
        </div>
      </div>
    </div>
  )
}
