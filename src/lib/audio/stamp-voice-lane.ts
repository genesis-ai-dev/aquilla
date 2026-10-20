import { firstPositionLaneId } from "../lanes/active-lane-choice"

/** The fields homing and stamping read. A `Voice` satisfies this. */
interface LaneVoice {
  id: string
  builtIn?: boolean
  laneId?: string
}

/** The built-in Narrator stays on every lane. A copied id from before lanes existed does too. */
export function voiceStaysOnEveryLane(voice: { id?: unknown; builtIn?: unknown }): boolean {
  return voice.builtIn === true || voice.id === "preset-narrator"
}

/**
 * The lane a stored voice counts as.
 * One that already names a lane keeps it. The Narrator names none, so it stays
 * on every lane. Any other voice with no lane belongs to `firstLaneId`: that
 * is the lane a single-lane project already had, and the lane it keeps when a
 * second one is added.
 */
export function laneIdForStoredVoice(
  voice: { id?: unknown; builtIn?: unknown; laneId?: unknown },
  firstLaneId: string | null | undefined,
): string | undefined {
  if (typeof voice.laneId === "string" && voice.laneId !== "") return voice.laneId
  if (voiceStaysOnEveryLane(voice)) return undefined
  return firstLaneId || undefined
}

/** First non-archived target lane in switcher order, when the rows know their position. */
export function firstLaneIdFromIdentities(
  lanes: readonly { id: string; position?: number; archivedAt?: string | null }[],
): string | null {
  const positioned = lanes.filter((lane): lane is { id: string; position: number; archivedAt?: string | null } =>
    typeof lane.position === "number")
  if (positioned.length > 0) {
    return firstPositionLaneId(positioned.map((lane) => ({
      id: lane.id,
      legacyTag: null,
      position: lane.position,
      archivedAt: lane.archivedAt ?? null,
    })))
  }
  return lanes.length === 1 ? lanes[0]!.id : null
}

/**
 * Write `firstLaneId` onto voices that have none and are not the Narrator.
 * Returns the same array when nothing changes.
 */
export function homeUnscopedVoices<T extends { id?: string; builtIn?: boolean; laneId?: string }>(
  voices: readonly T[],
  firstLaneId: string | null | undefined,
): readonly T[] {
  if (!firstLaneId) return voices
  let changed = false
  const next = voices.map((voice) => {
    if (laneIdForStoredVoice(voice, firstLaneId) === voice.laneId) return voice
    if (voiceStaysOnEveryLane(voice) || (typeof voice.laneId === "string" && voice.laneId !== "")) return voice
    changed = true
    return { ...voice, laneId: firstLaneId }
  })
  return changed ? next : voices
}

/** Same homing for a stored settings record. The same object when nothing moves. */
export function homeTtsVoiceRecords(
  tts: Record<string, unknown>,
  firstLaneId: string | null | undefined,
): Record<string, unknown> {
  if (!firstLaneId || !Array.isArray(tts.voices)) return tts
  let changed = false
  const voices = tts.voices.map((voice) => {
    if (!voice || typeof voice !== "object" || Array.isArray(voice)) return voice
    const record = voice as Record<string, unknown>
    const laneId = laneIdForStoredVoice(record, firstLaneId)
    if (!laneId || record.laneId === laneId) return voice
    changed = true
    return { ...record, laneId }
  })
  return changed ? { ...tts, voices } : tts
}

/** The one target lane row whose legacy tag is `tag`, or null when it isn't exactly one. */
export function targetLaneRowId(
  lanes: readonly { id: string; role: string; legacyTag: string | null }[] | undefined,
  tag: string,
): string | null {
  const matches = (lanes ?? []).filter((lane) => lane.role === "target" && (lane.legacyTag ?? "") === tag)
  return matches.length === 1 ? matches[0]!.id : null
}

/**
 * Put a voice in `laneId` unless it already names a lane, is a built-in
 * preset, or there is no lane to put it in. AQU-2037's write rule, kept here
 * so a project lead's new voice belongs to the lane they are writing.
 */
export function stampVoiceLane<T extends LaneVoice>(voice: T, laneId: string | null | undefined): T {
  if (!laneId || voice.builtIn || voice.laneId !== undefined) return voice
  return { ...voice, laneId }
}

/**
 * Stamp every voice in `next` that the stored library does not already hold.
 * Editing a voice never moves it. A voice stored before it had a lane stays
 * without one.
 */
export function stampNewVoiceLanes<T extends LaneVoice>(
  next: readonly T[],
  previous: readonly T[] | undefined,
  laneId: string | null | undefined,
): T[] {
  if (!laneId) return [...next]
  const stored = new Set((previous ?? []).map((voice) => voice.id))
  return next.map((voice) => (stored.has(voice.id) ? voice : stampVoiceLane(voice, laneId)))
}
