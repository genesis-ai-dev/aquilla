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
import { clearProjectTts, loadProjectTts, saveProjectTts } from "@/lib/store/project-tts-store"
import {
  assignedCastVoiceId, getVoiceLibrary,
} from "@/lib/audio/voices"
import {
  laneScopedTtsSettings, resolveLaneVoice, stampNewVoiceLanes,
} from "@/lib/audio/voice-lanes"
import {
  migrateOmnivoiceTtsSettings,
  omnivoiceMigrationProperties,
} from "@/lib/audio/omnivoice-migrate"
import { OMNIVOICE_VOICES_MIGRATED } from "@/lib/event-names"
import posthog from "@/lib/posthog"
import type { CastMemberStats } from "@/components/VoiceLibraryPanel"
import type { CellSummary } from "@/hooks/useActiveCellStore"
import type { ProjectTtsSettings, Voice } from "@/lib/parsers/types"

/**
 * What the server made of a mirrored write (AQU-1943). `rejected` means it
 * refused the VALUE — the TTS cap — so the durable local copy is rolled back
 * instead of being kept and re-sent. A role/offline block is NOT a rejection:
 * localStorage stays the client-owned source of truth there, by design.
 */
export interface TtsSyncOutcome {
  rejected: boolean
}

export interface ProjectTtsApi {
  /**
   * Effective settings for the WHOLE project: the localStorage overlay if
   * present, else the server copy. This is what writers merge into — a write
   * built from `laneSettings` would store one lane's voices and delete the
   * rest (AQU-2037).
   */
  settings: ProjectTtsSettings | undefined
  /**
   * AQU-2037: the same settings as the ACTIVE LANE sees them — its voices, its
   * resolved default, and only the cast assignments it has. Hand this to any
   * surface that lists or resolves voices (the per-cell picker, the batch
   * dialog, the Media-timeline picker, the cast gutter, Generate) and it
   * becomes lane-correct. Identical to `settings` when no lane is in view.
   */
  laneSettings: ProjectTtsSettings | undefined
  /** The active lane's voices — the list every picker offers (AQU-2037). */
  voices: Voice[]
  /** The whole project's voices. The seed for a library WRITE (AQU-2037). */
  allVoices: Voice[]
  /** The active lane's resolved default/narrator voice id. */
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
  onSyncTts?: (
    tts: Omit<ProjectTtsSettings, "apiKey">,
  ) => void | Promise<TtsSyncOutcome | void>,
  /** Project target-language lane — fills OmniVoice voices that stored no tag. */
  targetLanguage?: string,
  /**
   * AQU-2037: the open target lane's ROW id, or null for a project with no
   * target lane rows. It scopes every read below, and it is the lane a voice
   * stored for the first time is stamped with.
   */
  activeLaneId?: string | null,
): ProjectTtsApi {
  // Read durable settings synchronously from localStorage on first render (lazy
  // init), so a reload sees the saved voice library immediately. Falls back to
  // the server copy when nothing is stored yet.
  const [localTts, setLocalTts] = useState<ProjectTtsSettings | undefined>(
    () => (projectId ? loadProjectTts(projectId) : undefined),
  )

  // Re-read when the project changes (lazy init only runs for the first one).
  const loadedForRef = useRef<string | null | undefined>(projectId)
  const migratedForRef = useRef<string | null>(null)
  // AQU-1943: which save is the latest. A refusal arrives after its save, so a
  // rollback must not undo a LATER save that already succeeded.
  const writeSeqRef = useRef(0)
  useEffect(() => {
    if (loadedForRef.current === projectId) return
    loadedForRef.current = projectId
    migratedForRef.current = null
    setLocalTts(projectId ? loadProjectTts(projectId) : undefined)
  }, [projectId])

  const rawSettings = localTts ?? serverSettings
  const settings = useMemo(
    () => migrateOmnivoiceTtsSettings(rawSettings, { targetLanguage }),
    [rawSettings, targetLanguage],
  )

  const saveTts = useCallback(
    async (overrides: Partial<ProjectTtsSettings>) => {
      if (!projectId) return
      const previous = localTts ?? serverSettings
      const seq = ++writeSeqRef.current
      // AQU-2037: the one place a voice is given its lane. Every mint site —
      // New voice / Clone / voice design, an import with speaker labels,
      // diarization, "Adopt voices as cast" — writes the full next library
      // through here, so stamping here covers all of them and nothing else has
      // to know about lanes. Only ids the stored library does not already hold
      // are stamped: an edit never moves a voice between lanes.
      const patch = overrides.voices
        ? {
            ...overrides,
            voices: stampNewVoiceLanes(overrides.voices, previous?.voices, activeLaneId),
          }
        : overrides
      const merged = { ...(previous ?? {}), ...patch } as ProjectTtsSettings
      const next = migrateOmnivoiceTtsSettings(merged, { targetLanguage }) ?? merged
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
        // AQU-1943: the one outcome localStorage must NOT outlive is a refused
        // value — the server caps the voice library and the cast map, and this
        // store is what a reload reads first, so a kept copy would resurrect
        // the voice the server just refused and re-send it forever. Still not
        // awaited: saveTts resolves on the local write as it always has, and
        // the rollback lands when the answer does.
        void Promise.resolve(onSyncTts(profiles))
          .then((outcome) => {
            if (!outcome?.rejected) return
            if (writeSeqRef.current !== seq) return
            setLocalTts(previous)
            if (previous) saveProjectTts(projectId, previous)
            else clearProjectTts(projectId)
            return patchProject(projectId, (p) => {
              const rolledBack = { ...p }
              if (previous) rolledBack.ttsSettings = previous
              else delete rolledBack.ttsSettings
              return rolledBack
            })
          })
          .catch((err) => {
            console.warn("[useProjectTts] settings mirror failed", err)
          })
      }
    },
    [projectId, localTts, serverSettings, onSyncTts, targetLanguage, activeLaneId],
  )

  // AQU-1189: persist OmniVoice → Inworld once per project open so stored JSON
  // matches the runtime remap (including language tags). Runtime remap still
  // covers a blocked/offline save.
  useEffect(() => {
    if (!projectId || !settings) return
    const rawNeedsWrite = migrateOmnivoiceTtsSettings(rawSettings, { targetLanguage }) !== rawSettings
    const serverNeedsWrite = migrateOmnivoiceTtsSettings(serverSettings, { targetLanguage }) !== serverSettings
    if (!rawNeedsWrite && !serverNeedsWrite) return
    if (migratedForRef.current === projectId) return
    migratedForRef.current = projectId
    const source = rawNeedsWrite && serverNeedsWrite
      ? "both"
      : rawNeedsWrite
        ? "local"
        : "server"
    const before = rawNeedsWrite ? rawSettings : serverSettings
    posthog.capture(OMNIVOICE_VOICES_MIGRATED, {
      project_id: projectId,
      source,
      ...omnivoiceMigrationProperties(before, { targetLanguage }),
    })
    void saveTts(settings)
  }, [projectId, rawSettings, serverSettings, settings, targetLanguage, saveTts])

  const assignCells = useCallback(
    (cellIds: Iterable<string>, voiceId: string) => {
      const next = { ...(settings?.castAssignments ?? {}) }
      for (const cid of cellIds) next[cid] = voiceId
      void saveTts({ castAssignments: next })
    },
    [settings, saveTts],
  )

  const allVoices = useMemo(() => getVoiceLibrary(settings), [settings])
  // AQU-2037: everything a surface READS goes through the lane view. `settings`
  // stays whole so writers keep merging into the project's real library.
  const laneSettings = useMemo(
    () => laneScopedTtsSettings(settings, activeLaneId),
    [settings, activeLaneId],
  )
  const voices = useMemo(() => getVoiceLibrary(laneSettings), [laneSettings])
  const defaultVoiceId = useMemo(
    () => resolveLaneVoice(settings, undefined, activeLaneId).id,
    [settings, activeLaneId],
  )

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
      const vid = assignedCastVoiceId(laneSettings, c.id) ?? defaultVoiceId
      bump(vid, Boolean(c.selectedGeneratedVoiceAudioId))
    }
    return m
  }, [cells, laneSettings, defaultVoiceId])

  return { settings, laneSettings, voices, allVoices, defaultVoiceId, castStats, saveTts, assignCells }
}
