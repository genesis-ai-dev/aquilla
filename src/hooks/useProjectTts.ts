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
import { laneScopedTtsSettings, stampNewVoiceLanes } from "@/lib/audio/voice-lanes"
import { laneTtsSettings, setLaneCast, setLaneDefaultVoice } from "@/lib/audio/lane-cast"
import { copyCastsOntoSplitPieces, type SplitCastSource } from "@/lib/audio/split-cast"
import {
  castLinesOf,
  castPickPatch,
  expandCharacterCast,
  foldCastByCharacter,
  setLaneCharacterCast,
  type CastLine,
  type CastPick,
} from "@/lib/audio/character-cast"
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
   * Effective settings for the WHOLE project, as stored: the localStorage
   * overlay if present, else the server copy. This is what writers merge into —
   * a write built from `laneSettings` would store one lane's voices and delete
   * the rest (AQU-2037), or stamp one lane's cast and default over the
   * project-wide fallback every other lane reads (AQU-2038).
   */
  settings: ProjectTtsSettings | undefined
  /**
   * The same settings as the ACTIVE LANE sees them: its voices and only the
   * cast assignments pointing at them (AQU-2037), with `castAssignments` and
   * `defaultVoiceId` resolved for the lane — its own answers over the
   * project-wide fallback (AQU-2038). Hand this to any surface that lists or
   * resolves voices (the per-cell picker, the batch dialog, the Media-timeline
   * picker, the cast gutter, Generate, the playback bar) and it becomes
   * lane-correct. Identical to `settings` when no lane is in view and no lane
   * has a cast or a default of its own.
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
  /**
   * Merge a partial settings patch into IDB + local state. A `voices` patch is
   * the full next library, and the voices it adds are stamped with the active
   * lane (AQU-2037). A `defaultVoiceId` in the patch stars the voice for the
   * ACTIVE LANE — that is what the Voices panel's star means — and never
   * touches the project-wide default (AQU-2038).
   */
  saveTts: (overrides: Partial<ProjectTtsSettings>) => Promise<void>
  /**
   * Cast one or more cells on the active lane. `null` sends them back to the
   * lane's default voice. Other lanes are untouched (AQU-2038).
   */
  assignCells: (cellIds: Iterable<string>, voiceId: string | null) => void
  /**
   * AQU-2125: cast a whole character on the active lane — one entry, however
   * many lines it has. `lineIds` are the character's lines the caller can see;
   * see `setLaneCharacterCast`. `null` sends the character to the default.
   */
  assignCharacter: (castName: string, voiceId: string | null, lineIds: Iterable<string>) => void
  /** One pick in the voice picker, as far as its scope reaches (`castPickPatch`). */
  assignPick: (pick: CastPick) => void
  /**
   * AQU-2101: copy the original row's voice onto the new narration pieces, on
   * every lane map this client holds and on the project-wide map. Local only.
   * The server copy is a separate call, so a project lead's settings save —
   * which may not touch hidden lanes — is not the thing that writes them.
   */
  applySplitCastCopies: (splits: readonly SplitCastSource[]) => void
}

/**
 * AQU-2125: what the hook needs to know about characters.
 *
 * `foldLines` is read when a save happens, so a caller can hand over lines it
 * only has later in its render (a dubbing file's heard lines); without it the
 * fold uses the summaries' own characters. `mayWriteProjectCast` is true only
 * for a role the server lets rewrite the project-wide cast (maintainer and up):
 * a project lead's voice save may touch only per-lane keys (AQU-2041), so a
 * fold riding along on it would get the whole save refused.
 */
export interface ProjectTtsCastOptions {
  foldLines?: () => readonly CastLine[]
  mayWriteProjectCast?: boolean
}

const NO_CAST_OPTIONS: ProjectTtsCastOptions = {}

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
   * target lane rows. It scopes which voices every read below sees, and it is
   * the lane a voice stored for the first time is stamped with.
   */
  activeLaneId?: string | null,
  /**
   * AQU-2038: the same lane's legacy TAG (`''` is the default lane — the key
   * `cells`/`lanes` have used since AQU-538). The cast and the default voice
   * are read and written per lane under this key; everything else in the blob
   * — the engine, the key, the voice library — stays project-wide.
   */
  lane: string = "",
  castOptions: ProjectTtsCastOptions = NO_CAST_OPTIONS,
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
  // AQU-2212: the last write, until the render that shows it. Two saves in one
  // tick (add a voice, then cast it on the line it was added from) must each
  // build on the one before, not on the same stale render.
  const pendingRef = useRef<ProjectTtsSettings | undefined>(undefined)
  useEffect(() => {
    if (pendingRef.current === localTts) pendingRef.current = undefined
  }, [localTts])
  useEffect(() => {
    if (loadedForRef.current === projectId) return
    loadedForRef.current = projectId
    migratedForRef.current = null
    pendingRef.current = undefined
    setLocalTts(projectId ? loadProjectTts(projectId) : undefined)
  }, [projectId])

  const rawSettings = localTts ?? serverSettings
  const settings = useMemo(
    () => migrateOmnivoiceTtsSettings(rawSettings, { targetLanguage }),
    [rawSettings, targetLanguage],
  )

  // AQU-2125: the characters the loaded lines name. Read by the view below and
  // by the fold every save runs.
  const castLines = useStableCastLines(cells)

  // The durable write. Takes the WHOLE project-wide blob, already migrated —
  // `saveTts` builds that from a patch, and the OmniVoice migration below hands
  // over its rewritten copy without going through the patch rules.
  const writeSettings = useCallback(
    async (next: ProjectTtsSettings) => {
      if (!projectId) return
      const previous = pendingRef.current ?? localTts ?? serverSettings
      const seq = ++writeSeqRef.current
      pendingRef.current = next
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
            pendingRef.current = previous
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
    [projectId, localTts, serverSettings, onSyncTts],
  )

  const saveTts = useCallback(
    async (overrides: Partial<ProjectTtsSettings>) => {
      if (!projectId) return
      const previous = pendingRef.current ?? localTts ?? serverSettings
      let patch: Partial<ProjectTtsSettings> = overrides
      // AQU-2037: the one place a voice is given its lane. Every mint site —
      // New voice / voice design / training, an import with speaker labels,
      // diarization, "Adopt voices as cast" — writes the full next library
      // through here, so stamping here covers all of them and nothing else has
      // to know about lanes. Only ids the stored library does not already hold
      // are stamped: an edit never moves a voice between lanes.
      if (patch.voices) {
        patch = {
          ...patch,
          voices: stampNewVoiceLanes(patch.voices, previous?.voices, activeLaneId),
        }
      }
      // AQU-2038: starring a voice is a per-lane act. The Voices panel (and the
      // in-cell New voice host, and `upsertVoice` pinning the first voice) all say it with
      // a `defaultVoiceId` patch, so route that one key to this lane's default
      // and leave the project-wide one — the pre-lane fallback — alone.
      if ("defaultVoiceId" in patch) {
        const { defaultVoiceId: starred, ...rest } = patch
        patch = { ...rest, ...setLaneDefaultVoice(previous, lane, starred) }
      }
      let merged = { ...(previous ?? {}), ...patch } as ProjectTtsSettings
      // AQU-2125: every save by someone who may rewrite the project-wide cast
      // also folds the lines in view into one entry per character, so a project
      // cast line by line shrinks back under the size cap as it is worked on.
      // Never invents a cast map on a project that has none.
      if (castOptions.mayWriteProjectCast && merged.castAssignments) {
        const fold = foldCastByCharacter(merged.castAssignments, castOptions.foldLines?.() ?? castLines)
        if (fold.changed) merged = { ...merged, castAssignments: fold.castAssignments }
      }
      await writeSettings(migrateOmnivoiceTtsSettings(merged, { targetLanguage }) ?? merged)
    },
    [projectId, localTts, serverSettings, targetLanguage, activeLaneId, lane, writeSettings, castOptions, castLines],
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
    // The project-wide blob, NOT the lane view: this rewrites stored provider
    // tags, and going through `saveTts` would route its `defaultVoiceId` to one
    // lane's star (AQU-2038) — every voice in it is already stored, so there is
    // nothing for the lane stamping to do either (AQU-2037).
    void writeSettings(settings)
  }, [projectId, rawSettings, serverSettings, settings, targetLanguage, writeSettings])

  const assignCells = useCallback(
    (cellIds: Iterable<string>, voiceId: string | null) => {
      void saveTts(setLaneCast(pendingRef.current ?? localTts ?? serverSettings, lane, cellIds, voiceId))
    },
    [localTts, serverSettings, lane, saveTts],
  )

  const assignCharacter = useCallback(
    (castName: string, voiceId: string | null, lineIds: Iterable<string>) => {
      void saveTts(setLaneCharacterCast(pendingRef.current ?? localTts ?? serverSettings, lane, activeLaneId, castName, voiceId, lineIds))
    },
    [localTts, serverSettings, lane, activeLaneId, saveTts],
  )

  const assignPick = useCallback(
    (pick: CastPick) => {
      void saveTts(castPickPatch(pendingRef.current ?? localTts ?? serverSettings, lane, activeLaneId, pick))
    },
    [localTts, serverSettings, lane, activeLaneId, saveTts],
  )

  const applySplitCastCopies = useCallback(
    (splits: readonly SplitCastSource[]) => {
      if (!projectId) return
      const previous = (localTts ?? serverSettings) as Record<string, unknown> | undefined
      const copied = copyCastsOntoSplitPieces(previous, splits)
      if (!copied) return
      const next = copied as ProjectTtsSettings
      setLocalTts(next)
      saveProjectTts(projectId, next)
      void patchProject(projectId, (p) => ({ ...p, ttsSettings: next }))
    },
    [projectId, localTts, serverSettings],
  )

  const allVoices = useMemo(() => getVoiceLibrary(settings), [settings])
  // Everything a surface READS goes through the lane view, built in a fixed
  // order: first the lane-scoped library — which voices this lane can see
  // (AQU-2037) — then the lane's own cast and default projected over it
  // (AQU-2038), so a project-wide assignment naming a voice this lane cannot
  // see is not an assignment here. `settings` stays whole so writers keep
  // merging into the project's real library.
  //
  // AQU-2125: last, each loaded line's character entry is copied onto the line,
  // in this view only, so a surface that looks a voice up by line id alone
  // still hears the character's voice. `castLines` changes only when a
  // character does, not on every edit.
  const laneSettings = useMemo(
    () => expandCharacterCast(laneTtsSettings(laneScopedTtsSettings(settings, activeLaneId), lane), castLines),
    [settings, activeLaneId, lane, castLines],
  )
  const voices = useMemo(() => getVoiceLibrary(laneSettings), [laneSettings])
  const defaultVoiceId = useMemo(() => resolveVoice(laneSettings, undefined).id, [laneSettings])

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

  return {
    settings, laneSettings, voices, allVoices, defaultVoiceId, castStats,
    saveTts, assignCells, assignCharacter, assignPick, applySplitCastCopies,
  }
}

/**
 * The summaries' characters, as the same array for as long as no line's
 * character changes — the read view above depends on it, and a new array on
 * every keystroke would rebuild the view and every memo downstream of it.
 */
function useStableCastLines(cells: readonly CellSummary[]): CastLine[] {
  const signature = useMemo(
    () => castLinesOf(cells).map((l) => `${l.id}${FIELD}${l.castName}`).join(LINE),
    [cells],
  )
  return useMemo(() => parseCastLines(signature), [signature])
}

const FIELD = "\u0000"
const LINE = "\u0001"

function parseCastLines(signature: string): CastLine[] {
  if (signature === "") return []
  return signature.split(LINE).map((entry) => {
    const at = entry.indexOf(FIELD)
    return { id: entry.slice(0, at), castName: entry.slice(at + 1) }
  })
}
