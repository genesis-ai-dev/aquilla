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
  assignedCastVoiceId, getVoiceLibrary, resolveVoice,
} from "@/lib/audio/voices"
import { laneTtsSettings, setLaneCast, setLaneDefaultVoice } from "@/lib/audio/lane-cast"
import { homeUnscopedVoices, stampNewVoiceLanes } from "@/lib/audio/stamp-voice-lane"
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
   * Effective settings for the ACTIVE LANE: the localStorage overlay if
   * present, else the server copy, with `castAssignments` and `defaultVoiceId`
   * resolved for the lane (AQU-2038). This is what every voice read should
   * use — the gutter, Generate, the timeline, the playback bar.
   */
  settings: ProjectTtsSettings | undefined
  /**
   * The same settings UNPROJECTED — the project-wide cast and default as
   * stored. Only the paths that legitimately write the project-wide cast want
   * this: importing a character sheet, and diarization adopting a speaker.
   */
  projectSettings: ProjectTtsSettings | undefined
  voices: Voice[]
  /** The active lane's resolved default/narrator voice id. */
  defaultVoiceId: string
  /** Per-cast line counts for the current cells (voiceId → assigned/voiced). */
  castStats: Map<string, CastMemberStats>
  /**
   * Merge a partial settings patch into IDB + local state. AQU-2038: a
   * `defaultVoiceId` in the patch stars the voice for the ACTIVE LANE — that
   * is what the Voices panel's star means — and never touches the
   * project-wide default.
   */
  saveTts: (overrides: Partial<ProjectTtsSettings>) => Promise<void>
  /**
   * Cast one or more cells on the active lane. `null` sends them back to the
   * lane's default voice. Other lanes are untouched (AQU-2038).
   */
  assignCells: (cellIds: Iterable<string>, voiceId: string | null) => void
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
   * AQU-2038: the lane being worked in (`''` is the default lane). The cast and
   * the default voice are read and written per lane; everything else in the
   * blob — the engine, the key, the voice library — stays project-wide.
   */
  lane: string = "",
  /**
   * Lane row id a voice is stamped with the first time it is saved. Null when
   * the open lane has no row yet. Editing a voice never moves it.
   */
  activeLaneId: string | null = null,
  /**
   * First target lane in switcher order. A stored voice with no lane, other
   * than the Narrator, is written onto this lane so it stays there when a
   * second lane is added.
   */
  firstLaneId: string | null = null,
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
  const projectSettings = useMemo(
    () => migrateOmnivoiceTtsSettings(rawSettings, { targetLanguage }),
    [rawSettings, targetLanguage],
  )
  // AQU-2038: everything downstream reads the lane's answers, so the lane is
  // resolved exactly once, here.
  const settings = useMemo(
    () => laneTtsSettings(projectSettings, lane),
    [projectSettings, lane],
  )

  // The durable write. Takes the WHOLE project-wide blob, already migrated —
  // `saveTts` builds that from a patch, and the OmniVoice migration below hands
  // over its rewritten copy without going through the patch rules.
  const writeSettings = useCallback(
    async (next: ProjectTtsSettings) => {
      if (!projectId) return
      if (next.voices) {
        const voices = homeUnscopedVoices(next.voices, firstLaneId)
        if (voices !== next.voices) next = { ...next, voices: [...voices] }
      }
      const previous = localTts ?? serverSettings
      const seq = ++writeSeqRef.current
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
    [projectId, localTts, serverSettings, onSyncTts, firstLaneId],
  )

  const saveTts = useCallback(
    async (overrides: Partial<ProjectTtsSettings>) => {
      if (!projectId) return
      const previous = localTts ?? serverSettings
      // AQU-2038: starring a voice is a per-lane act. The Voices panel (and the
      // clone host, and `upsertVoice` pinning the first voice) all say it with
      // a `defaultVoiceId` patch, so route that one key to this lane's default
      // and leave the project-wide one — the pre-lane fallback — alone.
      let patch: Partial<ProjectTtsSettings> = overrides
      if ("defaultVoiceId" in overrides) {
        const { defaultVoiceId: starred, ...rest } = overrides
        patch = { ...rest, ...setLaneDefaultVoice(previous, lane, starred) }
      }
      if (patch.voices) {
        patch = { ...patch, voices: stampNewVoiceLanes(patch.voices, previous?.voices, activeLaneId) }
      }
      const merged = { ...(previous ?? {}), ...patch } as ProjectTtsSettings
      await writeSettings(migrateOmnivoiceTtsSettings(merged, { targetLanguage }) ?? merged)
    },
    [projectId, localTts, serverSettings, targetLanguage, lane, activeLaneId, writeSettings],
  )

  // AQU-1189: persist OmniVoice → Inworld once per project open so stored JSON
  // matches the runtime remap (including language tags). Runtime remap still
  // covers a blocked/offline save.
  useEffect(() => {
    if (!projectId || !projectSettings) return
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
    // The project-wide blob, NOT the lane projection: this rewrites stored
    // provider tags, and writing a projection back would stamp one lane's cast
    // over the project-wide fallback every other lane reads (AQU-2038).
    void writeSettings(projectSettings)
  }, [projectId, rawSettings, serverSettings, projectSettings, targetLanguage, writeSettings])

  const assignCells = useCallback(
    (cellIds: Iterable<string>, voiceId: string | null) => {
      void saveTts(setLaneCast(localTts ?? serverSettings, lane, cellIds, voiceId))
    },
    [localTts, serverSettings, lane, saveTts],
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

  return { settings, projectSettings, voices, defaultVoiceId, castStats, saveTts, assignCells }
}
