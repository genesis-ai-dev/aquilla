// Project TTS settings (engine, voice library, Gemini key, cast assignments).
//
// Persistence lives in localStorage keyed by projectId (project-tts-store), NOT
// the IDB project record: under the AD-3 thin client the project record is
// server-sourced and re-hydrated on load, and patchProject no-ops when no IDB
// row exists yet — so settings written only there were silently dropped on
// reload (this is why a freshly created voice didn't persist). We still mirror
// into the IDB record best-effort for any local-only project, but localStorage
// is the source of truth on read.

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { patchProject } from "@/lib/store/project-index"
import { loadProjectTts, saveProjectTts } from "@/lib/store/project-tts-store"
import {
  assignedCastVoiceId, getVoiceLibrary, resolveVoice,
} from "@/lib/audio/voices"
import type { CastMemberStats } from "@/components/VoiceLibraryPanel"
import type { CellSummary } from "@/hooks/useActiveCellStore"
import type { ProjectTtsSettings, Voice } from "@/lib/parsers/types"

export interface ProjectTtsApi {
  /** Effective settings: the localStorage overlay if present, else the server copy. */
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
  cells: readonly CellSummary[],
  /** Persist voice profiles (minus apiKey) to the server settings blob so they
   *  sync across devices. Fire-and-forget; localStorage stays the durable
   *  client-owned source. */
  onSyncTts?: (tts: Omit<ProjectTtsSettings, "apiKey">) => void,
): ProjectTtsApi {
  // Read durable settings synchronously from localStorage on first render (lazy
  // init), so a reload sees the saved voice library immediately. Falls back to
  // the server copy when nothing is stored yet.
  const [localTts, setLocalTts] = useState<ProjectTtsSettings | undefined>(
    () => (projectId ? loadProjectTts(projectId) : undefined),
  )

  // Re-read when the project changes (lazy init only runs for the first one).
  const loadedForRef = useRef<string | null | undefined>(projectId)
  useEffect(() => {
    if (loadedForRef.current === projectId) return
    loadedForRef.current = projectId
    setLocalTts(projectId ? loadProjectTts(projectId) : undefined)
  }, [projectId])

  const settings = localTts ?? serverSettings

  const saveTts = useCallback(
    async (overrides: Partial<ProjectTtsSettings>) => {
      if (!projectId) return
      const next = { ...(localTts ?? serverSettings ?? {}), ...overrides } as ProjectTtsSettings
      setLocalTts(next)
      // Source of truth: durable, client-owned, survives reload + pulls.
      saveProjectTts(projectId, next)
      // Best-effort mirror for local-only projects that DO have an IDB row.
      await patchProject(projectId, (p) => ({ ...p, ttsSettings: next }))
      // Also persist voice profiles to the server settings blob (cross-device).
      // apiKey is stripped — it stays device-local. Fire-and-forget; a blocked
      // (role/offline) outcome is fine since localStorage remains durable.
      if (onSyncTts) {
        const { apiKey, ...profiles } = next
        void apiKey
        onSyncTts(profiles)
      }
    },
    [projectId, localTts, serverSettings, onSyncTts],
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
