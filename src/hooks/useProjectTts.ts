// Project TTS settings, hydrated from IDB and overlaid on the server record.
//
// `useProject` returns the server project WITHOUT ttsSettings (engine, voice
// library, Gemini key, cast assignments) — those live only in local IDB. The
// Voice Studio used to hydrate them inline; now the editor's Audio lens needs
// the same data, so the logic lives here once. Returns the resolved settings
// plus the derived voice library / cast stats and the writers the lens needs.

import { useCallback, useEffect, useMemo, useState } from "react"
import { getProject, patchProject } from "@/lib/store/project-index"
import {
  assignedCastVoiceId, getVoiceLibrary, resolveVoice,
} from "@/lib/audio/voices"
import type { CastMemberStats } from "@/components/VoiceLibraryPanel"
import type { CellData } from "@/hooks/useCells"
import type { ProjectTtsSettings, Voice } from "@/lib/parsers/types"

export interface ProjectTtsApi {
  /** Effective settings: local IDB overlay if hydrated, else the server copy. */
  settings: ProjectTtsSettings | undefined
  voices: Voice[]
  /** The project's resolved default/narrator voice id. */
  defaultVoiceId: string
  /** Per-cast line counts for the current cells (voiceId → assigned/voiced). */
  castStats: Map<string, CastMemberStats>
  /** Merge a partial settings patch into IDB + local state. */
  saveTts: (overrides: Partial<ProjectTtsSettings>) => Promise<void>
  /** Assign one or more cells to a cast member (voice). */
  assignCells: (cellIds: Iterable<string>, voiceId: string) => void
}

export function useProjectTts(
  projectId: string | null | undefined,
  serverSettings: ProjectTtsSettings | undefined,
  cells: CellData[],
): ProjectTtsApi {
  // TTS settings live in local IDB; the server record returned by useProject
  // omits them, so hydrate + overlay separately.
  const [localTts, setLocalTts] = useState<ProjectTtsSettings | undefined>(undefined)

  useEffect(() => {
    if (!projectId) return
    void getProject(projectId).then((p) => { if (p) setLocalTts(p.ttsSettings) })
  }, [projectId])

  const settings = localTts ?? serverSettings

  const saveTts = useCallback(
    async (overrides: Partial<ProjectTtsSettings>) => {
      if (!projectId) return
      setLocalTts((cur) => ({ ...(cur ?? {}), ...overrides } as ProjectTtsSettings))
      await patchProject(projectId, (p) => ({
        ...p,
        ttsSettings: { ...p.ttsSettings, ...overrides },
      }))
    },
    [projectId],
  )

  const assignCells = useCallback(
    (cellIds: Iterable<string>, voiceId: string) => {
      const next = { ...(settings?.castAssignments ?? {}) }
      for (const cid of cellIds) next[cid] = voiceId
      void saveTts({ castAssignments: next })
    },
    [settings, saveTts],
  )

  const voices = useMemo(() => getVoiceLibrary(settings), [settings])
  const defaultVoiceId = useMemo(() => resolveVoice(settings, undefined).id, [settings])

  // Per-cast line counts (assigned + already-voiced). Unassigned lines roll up
  // to the default/narrator member so its count reflects reality. Mirrors the
  // Voice Studio rail's stats.
  const castStats = useMemo(() => {
    const m = new Map<string, CastMemberStats>()
    const bump = (vid: string, voiced: boolean) => {
      const s = m.get(vid) ?? { assigned: 0, voiced: 0 }
      s.assigned += 1
      if (voiced) s.voiced += 1
      m.set(vid, s)
    }
    for (const c of cells) {
      if (c.type === "paratext" || !c.translated?.trim()) continue
      const vid = assignedCastVoiceId(settings, c.id) ?? defaultVoiceId
      bump(vid, Boolean(c.selectedGeneratedVoiceAudioId))
    }
    return m
  }, [cells, settings, defaultVoiceId])

  return { settings, voices, defaultVoiceId, castStats, saveTts, assignCells }
}
