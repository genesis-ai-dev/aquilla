// AQU-2038: each target lane keeps its own cast (cell → voice) and its own
// default voice.
//
// WHY A PROJECTION RATHER THAN A LANE ARGUMENT EVERYWHERE. The cast is read in
// ~15 places — the gutter picker, the cast label, Generate, batch change-voice,
// the timeline, the playback bar, the export assemblers — and every one of them
// already takes a `ProjectTtsSettings`. Threading a lane through all of them
// would touch each call site and still leave the next one free to forget. So the
// lane is resolved ONCE, where the settings are read (`useProjectTts`), and the
// rest of the app keeps reading `castAssignments` / `defaultVoiceId` — only now
// they hold the ACTIVE LANE's answers. Writers go through `setLaneCast` /
// `setLaneDefaultVoice`, which touch one lane's key and nothing else.
//
// The project-wide `castAssignments` / `defaultVoiceId` stay the pre-lane
// fallback and are never rewritten by a lane's choice, which is what keeps a
// migrated project generating on every lane (AQU-2039 is the migration).
//
// ORDER WITH AQU-2037. `voice-lanes.ts` owns WHICH VOICES a lane can see;
// this module owns which of them speaks each cell and which is starred.
// `useProjectTts` applies them in that order — `laneTtsSettings(
// laneScopedTtsSettings(settings, laneId), lane)` — so the library this
// projection reads is already the lane's, and "visible on the lane" below
// means exactly that.

import type { ProjectTtsSettings } from "@/lib/parsers/types"
import { NO_CAST_VOICE, getVoiceLibrary } from "./voices"

/**
 * Stored where a lane has deliberately gone back to its default: "no voice",
 * as opposed to "nothing said yet" (an absent key), which still inherits the
 * project-wide assignment. A real voice id is never empty.
 */
export const LANE_CAST_DEFAULT = ""

/**
 * The voices this lane can see: the library of the settings handed in. Given
 * the lane-scoped view from `voice-lanes.ts` (AQU-2037) — which is what
 * `useProjectTts` passes — that is the lane's own library, and the proviso
 * below ("...provided that voice is visible on the lane") is the real rule.
 * Given the whole project blob instead it degrades to every voice.
 */
function visibleVoiceIds(settings: ProjectTtsSettings): Set<string> {
  return new Set(getVoiceLibrary(settings).map((v) => v.id))
}

/**
 * Read `settings` as the lane sees it: `castAssignments` and `defaultVoiceId`
 * resolved for `lane` (`''` is the default lane).
 *
 * Returns the SAME object while no lane has a cast or a default of its own, so
 * a project that predates AQU-2038 — every single-lane project included — is
 * byte-identical to before, and React memos downstream don't churn.
 */
export function laneTtsSettings(
  settings: ProjectTtsSettings | undefined,
  lane: string,
): ProjectTtsSettings | undefined {
  if (!settings) return settings
  const laneCast = settings.laneCastAssignments
  const laneDefaults = settings.laneDefaultVoiceId
  if (!laneCast && !laneDefaults) return settings

  const visible = visibleVoiceIds(settings)
  const own = laneCast?.[lane]
  const legacy = settings.castAssignments

  let castAssignments: Record<string, string> | undefined
  if (legacy || own) {
    castAssignments = {}
    // The project-wide cast first — but only where this lane can see the voice.
    // A "no voice" entry is kept as it is (AQU-2125): it is what stops a
    // character's entry from recasting that line.
    for (const [cellId, voiceId] of Object.entries(legacy ?? {})) {
      if (voiceId === NO_CAST_VOICE || visible.has(voiceId)) castAssignments[cellId] = voiceId
    }
    // Then this lane's own answers, which always win. A lane sent back to its
    // default stays in the view as "no voice" rather than being deleted, so a
    // character cast elsewhere cannot take the line back (AQU-2125).
    for (const [cellId, voiceId] of Object.entries(own ?? {})) {
      castAssignments[cellId] = voiceId === LANE_CAST_DEFAULT ? NO_CAST_VOICE : voiceId
    }
  }

  const laneDefault = laneDefaults?.[lane]
  const fallbackDefault = settings.defaultVoiceId && visible.has(settings.defaultVoiceId)
    ? settings.defaultVoiceId
    : undefined
  // An empty string is the lane saying "I have no default", which outranks the
  // project-wide one; an absent key inherits it.
  const defaultVoiceId = laneDefault === undefined
    ? fallbackDefault
    : laneDefault !== LANE_CAST_DEFAULT && visible.has(laneDefault)
      ? laneDefault
      : undefined

  const next: ProjectTtsSettings = { ...settings }
  // `prunePhantomVoices` leans on the difference between an absent cast map and
  // an empty one; don't invent one for a project that has never had a cast.
  if (castAssignments) next.castAssignments = castAssignments
  if (defaultVoiceId === undefined) delete next.defaultVoiceId
  else next.defaultVoiceId = defaultVoiceId
  return next
}

/**
 * Cast `cellIds` on one lane. `voiceId: null` sends them back to the lane's
 * default — stored as {@link LANE_CAST_DEFAULT} rather than deleted, so the
 * choice sticks on a project whose pre-lane cast names a voice for that cell.
 * Only `lane`'s key changes.
 */
export function setLaneCast(
  settings: ProjectTtsSettings | undefined,
  lane: string,
  cellIds: Iterable<string>,
  voiceId: string | null,
): Pick<ProjectTtsSettings, "laneCastAssignments"> {
  const next = { ...(settings?.laneCastAssignments?.[lane] ?? {}) }
  for (const cellId of cellIds) next[cellId] = voiceId ?? LANE_CAST_DEFAULT
  return {
    laneCastAssignments: { ...(settings?.laneCastAssignments ?? {}), [lane]: next },
  }
}

/**
 * Drop `cellIds` from EVERY lane's cast. The companion to `buildCastRemovals`,
 * which prunes the project-wide map: "No character" unassigns the SHARED
 * character sheet, and a character name is one value for every lane (AQU-2038),
 * so a lane-local voice must not outlive the character it was speaking. Returns
 * nothing to write when no lane has a cast.
 */
export function clearLaneCast(
  settings: ProjectTtsSettings | undefined,
  cellIds: Iterable<string>,
): Pick<ProjectTtsSettings, "laneCastAssignments"> | Record<string, never> {
  const lanes = settings?.laneCastAssignments
  if (!lanes) return {}
  const cleared = new Set(cellIds)
  const next: Record<string, Record<string, string>> = {}
  for (const [lane, cast] of Object.entries(lanes)) {
    const kept: Record<string, string> = {}
    for (const [cellId, voiceId] of Object.entries(cast)) {
      if (!cleared.has(cellId)) kept[cellId] = voiceId
    }
    next[lane] = kept
  }
  return { laneCastAssignments: next }
}

/**
 * Star `voiceId` as this lane's default. `undefined` records that the lane has
 * no default of its own (the sentinel), which is what the Voices panel means
 * when the starred voice is deleted — the project-wide default must not quietly
 * take the star back.
 */
export function setLaneDefaultVoice(
  settings: ProjectTtsSettings | undefined,
  lane: string,
  voiceId: string | undefined,
): Pick<ProjectTtsSettings, "laneDefaultVoiceId"> {
  return {
    laneDefaultVoiceId: {
      ...(settings?.laneDefaultVoiceId ?? {}),
      [lane]: voiceId ?? LANE_CAST_DEFAULT,
    },
  }
}
