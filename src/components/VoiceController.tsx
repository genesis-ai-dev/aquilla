// Always-mounted voice host for the workspace. Owns the VoiceModal open state,
// registers the imperative voice actions (so EditorTable's voice-chip drops and
// the per-cell AI-status popovers' "Open voice settings" links resolve), and
// implements drop-to-generate. Renders nothing but the modal.

import { useCallback, useEffect, useRef, useState } from "react"
import { VoiceModal } from "./VoiceModal"
import { registerVoiceActions } from "@/lib/audio/voice-actions"
import { generateCellVoice } from "@/lib/audio/voice-generate-helpers"
import { patchProject } from "@/lib/store/project-index"
import type { CellData } from "@/hooks/useCells"
import type { ProjectRecord, ProjectTtsSettings } from "@/lib/parsers/types"
import type { FrontierSession } from "@/lib/frontier/types"

interface Props {
  project: ProjectRecord
  /** Active file id — used only to mint a project-valid sync token for clone
   *  reference uploads. Falls back to the project's first file. */
  activeFileId: string | null
  cells: CellData[]
  username: string
  session: FrontierSession | null
  onProjectChanged: () => void
}

export function VoiceController({
  project, activeFileId, cells, username, session, onProjectChanged,
}: Props) {
  const [open, setOpen] = useState(false)
  const [initialFocus, setInitialFocus] = useState<"apiKey" | undefined>(undefined)

  // Keep the latest props in a ref so the registered handlers (registered once)
  // always see current cells/session without re-registering each render. The
  // ref is written in an effect (not during render) so the handlers see the
  // committed props.
  const ctx = useRef({ project, cells, session, username, onProjectChanged })
  useEffect(() => {
    ctx.current = { project, cells, session, username, onProjectChanged }
  })

  useEffect(() => {
    return registerVoiceActions({
      openModal: (focus) => {
        setInitialFocus(focus)
        setOpen(true)
      },
      drop: async (cellId, voiceId) => {
        const { project, cells, session, username, onProjectChanged } = ctx.current
        const cell = cells.find((c) => c.id === cellId)
        if (!cell) return
        const ok = await generateCellVoice({ project, cell, session, username, voiceId })
        if (ok) onProjectChanged()
      },
    })
  }, [])

  const fileIdForToken = activeFileId ?? project.files[0]?.id ?? null

  const saveTts = useCallback(
    async (overrides: Partial<ProjectTtsSettings>) => {
      await patchProject(project.id, (p) => ({
        ...p,
        ttsSettings: { ...p.ttsSettings, ...overrides },
      }))
      onProjectChanged()
    },
    [project.id, onProjectChanged],
  )

  return (
    <VoiceModal
      open={open}
      onOpenChange={setOpen}
      targetLanguage={project.targetLanguage}
      settings={project.ttsSettings}
      onSettingsChange={saveTts}
      initialFocus={initialFocus}
      projectId={project.id}
      fileId={fileIdForToken}
      session={session}
    />
  )
}
