/**
 * AQU-2043: the lane read wall covers voices.
 *
 * A member who cannot read a lane does not receive that lane's voices, its
 * per-lane cast, or its per-lane default. A voice with no laneId is not
 * lane-owned yet (pre-migration voices and the built-in Narrator) and stays.
 * Cast and default maps are keyed by legacy tag (`''` is the default lane).
 * `visible === null` means the caller sees every lane.
 */

import type { LaneIdentity } from "./read-wall"

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value)
}

function voiceList(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return []
  return value.filter(isRecord)
}

function voiceId(voice: Record<string, unknown>): string | null {
  return typeof voice.id === "string" && voice.id !== "" ? voice.id : null
}

/** A voice is hidden only when it names a lane the caller cannot read. */
export function voiceHidden(voice: Record<string, unknown>, visible: ReadonlySet<string>): boolean {
  const laneId = voice.laneId
  return typeof laneId === "string" && laneId !== "" && !visible.has(laneId)
}

function hiddenVoiceIds(voices: readonly Record<string, unknown>[], visible: ReadonlySet<string>): Set<string> {
  const ids = new Set<string>()
  for (const voice of voices) {
    if (!voiceHidden(voice, visible)) continue
    const id = voiceId(voice)
    if (id) ids.add(id)
  }
  return ids
}

/** Cast maps use a legacy tag. One matching lane that the caller cannot read hides the key. */
function laneKeyHidden(tag: string, visible: ReadonlySet<string>, lanes: readonly LaneIdentity[]): boolean {
  const matches = lanes.filter((lane) => (lane.legacyTag ?? "") === tag)
  if (matches.length !== 1) return false
  return !visible.has(matches[0]!.id)
}

function pointsAtHiddenVoice(value: unknown, hiddenIds: ReadonlySet<string>): boolean {
  return typeof value === "string" && value !== "" && hiddenIds.has(value)
}

function filterVoiceIdMap(map: Record<string, unknown>, hiddenIds: ReadonlySet<string>): Record<string, unknown> {
  const next: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(map)) {
    if (pointsAtHiddenVoice(value, hiddenIds)) continue
    next[key] = value
  }
  return next
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * The copy a walled member is allowed to see. Does not mutate `tts`.
 * Project-wide cast cells and the project-wide default are dropped when they
 * point at a hidden lane's voice, so that voice id is not in the response.
 */
export function filterTtsSettingsToVisibleLanes(
  tts: Record<string, unknown>,
  visible: ReadonlySet<string> | null,
  lanes: readonly LaneIdentity[],
): Record<string, unknown> {
  if (visible === null) return tts
  const voices = voiceList(tts.voices)
  const hiddenIds = hiddenVoiceIds(voices, visible)
  const next: Record<string, unknown> = { ...tts }

  if ("voices" in tts) {
    next.voices = voices.filter((voice) => !voiceHidden(voice, visible))
  }
  if (isRecord(tts.castAssignments)) {
    const cast = filterVoiceIdMap(tts.castAssignments, hiddenIds)
    if (Object.keys(cast).length === 0) delete next.castAssignments
    else next.castAssignments = cast
  }
  if (pointsAtHiddenVoice(tts.defaultVoiceId, hiddenIds)) delete next.defaultVoiceId
  if (isRecord(tts.laneCastAssignments)) {
    const map: Record<string, unknown> = {}
    for (const [tag, value] of Object.entries(tts.laneCastAssignments)) {
      if (laneKeyHidden(tag, visible, lanes) || !isRecord(value)) continue
      const cells = filterVoiceIdMap(value, hiddenIds)
      if (Object.keys(cells).length === 0) continue
      map[tag] = cells
    }
    if (Object.keys(map).length === 0) delete next.laneCastAssignments
    else next.laneCastAssignments = map
  }
  if (isRecord(tts.laneDefaultVoiceId)) {
    const map: Record<string, unknown> = {}
    for (const [tag, value] of Object.entries(tts.laneDefaultVoiceId)) {
      if (laneKeyHidden(tag, visible, lanes)) continue
      if (pointsAtHiddenVoice(value, hiddenIds)) continue
      map[tag] = value
    }
    if (Object.keys(map).length === 0) delete next.laneDefaultVoiceId
    else next.laneDefaultVoiceId = map
  }
  return next
}

function mergeVoices(
  stored: readonly Record<string, unknown>[],
  incoming: readonly Record<string, unknown>[],
  visible: ReadonlySet<string>,
): Record<string, unknown>[] {
  const incomingById = new Map<string, Record<string, unknown>>()
  for (const voice of incoming) {
    const id = voiceId(voice)
    if (id) incomingById.set(id, voice)
  }
  const used = new Set<string>()
  const next: Record<string, unknown>[] = []
  for (const voice of stored) {
    const id = voiceId(voice)
    if (voiceHidden(voice, visible)) {
      next.push(voice)
      if (id) used.add(id)
      continue
    }
    if (!id) continue
    const sent = incomingById.get(id)
    if (!sent || voiceHidden(sent, visible)) continue
    next.push(sameJson(sent, voice) ? voice : sent)
    used.add(id)
  }
  for (const voice of incoming) {
    const id = voiceId(voice)
    if (!id || used.has(id) || voiceHidden(voice, visible)) continue
    next.push(voice)
    used.add(id)
  }
  return next
}

function mergeCastMap(
  stored: Record<string, unknown>,
  incoming: Record<string, unknown>,
  hiddenIds: ReadonlySet<string>,
): Record<string, unknown> {
  const filtered = filterVoiceIdMap(stored, hiddenIds)
  if (sameJson(incoming, stored) || sameJson(incoming, filtered)) return stored
  const next: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(stored)) {
    if (pointsAtHiddenVoice(value, hiddenIds)) {
      next[key] = value
      continue
    }
    if (key in incoming && !pointsAtHiddenVoice(incoming[key], hiddenIds)) next[key] = incoming[key]
  }
  for (const [key, value] of Object.entries(incoming)) {
    if (key in next || pointsAtHiddenVoice(value, hiddenIds)) continue
    next[key] = value
  }
  return next
}

function mergeLaneCast(
  stored: Record<string, unknown>,
  incoming: Record<string, unknown>,
  visible: ReadonlySet<string>,
  lanes: readonly LaneIdentity[],
  hiddenIds: ReadonlySet<string>,
): Record<string, unknown> {
  const next: Record<string, unknown> = {}
  const seen = new Set<string>()
  for (const [tag, value] of Object.entries(stored)) {
    seen.add(tag)
    if (!isRecord(value)) {
      next[tag] = value
      continue
    }
    if (laneKeyHidden(tag, visible, lanes)) {
      next[tag] = value
      continue
    }
    const sent = isRecord(incoming[tag]) ? incoming[tag] : null
    if (!sent) {
      const kept = filterVoiceIdMap(value, hiddenIds)
      if (Object.keys(kept).length === 0 && Object.keys(value).length > 0) next[tag] = value
      continue
    }
    next[tag] = mergeCastMap(value, sent, hiddenIds)
  }
  for (const [tag, value] of Object.entries(incoming)) {
    if (seen.has(tag) || laneKeyHidden(tag, visible, lanes) || !isRecord(value)) continue
    const cells = filterVoiceIdMap(value, hiddenIds)
    if (Object.keys(cells).length > 0) next[tag] = cells
  }
  return next
}

function mergeLaneDefaults(
  stored: Record<string, unknown>,
  incoming: Record<string, unknown>,
  visible: ReadonlySet<string>,
  lanes: readonly LaneIdentity[],
  hiddenIds: ReadonlySet<string>,
): Record<string, unknown> {
  const next: Record<string, unknown> = {}
  const seen = new Set<string>()
  for (const [tag, value] of Object.entries(stored)) {
    seen.add(tag)
    if (laneKeyHidden(tag, visible, lanes)) {
      next[tag] = value
      continue
    }
    if (!(tag in incoming)) {
      if (pointsAtHiddenVoice(value, hiddenIds)) next[tag] = value
      continue
    }
    const sent = incoming[tag]
    if (pointsAtHiddenVoice(sent, hiddenIds) || sent === value) next[tag] = value
    else next[tag] = sent
  }
  for (const [tag, value] of Object.entries(incoming)) {
    if (seen.has(tag) || laneKeyHidden(tag, visible, lanes)) continue
    if (pointsAtHiddenVoice(value, hiddenIds)) continue
    next[tag] = value
  }
  return next
}

function mergeDefaultVoice(
  stored: Record<string, unknown>,
  incoming: Record<string, unknown>,
  hiddenIds: ReadonlySet<string>,
): { present: boolean; value: unknown } {
  const storedHas = "defaultVoiceId" in stored
  const incomingHas = "defaultVoiceId" in incoming
  if (!storedHas && !incomingHas) return { present: false, value: undefined }
  const storedId = stored.defaultVoiceId
  if (pointsAtHiddenVoice(storedId, hiddenIds)) return { present: true, value: storedId }
  if (!incomingHas) return { present: false, value: undefined }
  if (pointsAtHiddenVoice(incoming.defaultVoiceId, hiddenIds)) {
    return storedHas ? { present: true, value: storedId } : { present: false, value: undefined }
  }
  return { present: true, value: incoming.defaultVoiceId === storedId ? storedId : incoming.defaultVoiceId }
}

/**
 * Put a hidden lane's voices, cast, and default back onto a save that was
 * built from a filtered read. An echo of that read comes back equal to
 * `stored`. A change to a lane the caller can see is kept. A change that
 * names a hidden lane is ignored, so the stored lane stays as it was.
 */
export function restoreHiddenTtsSettings(
  stored: Record<string, unknown>,
  incoming: Record<string, unknown>,
  visible: ReadonlySet<string> | null,
  lanes: readonly LaneIdentity[],
): Record<string, unknown> {
  if (visible === null) return incoming
  const storedVoices = voiceList(stored.voices)
  const hiddenIds = hiddenVoiceIds(storedVoices, visible)
  const produced: Record<string, unknown> = {}

  if ("voices" in stored || "voices" in incoming) {
    produced.voices = mergeVoices(storedVoices, voiceList(incoming.voices), visible)
  }
  if (isRecord(stored.castAssignments) || isRecord(incoming.castAssignments)) {
    produced.castAssignments = mergeCastMap(
      isRecord(stored.castAssignments) ? stored.castAssignments : {},
      isRecord(incoming.castAssignments) ? incoming.castAssignments : {},
      hiddenIds,
    )
  }
  const defaultVoice = mergeDefaultVoice(stored, incoming, hiddenIds)
  if (defaultVoice.present) produced.defaultVoiceId = defaultVoice.value
  if (isRecord(stored.laneCastAssignments) || isRecord(incoming.laneCastAssignments)) {
    produced.laneCastAssignments = mergeLaneCast(
      isRecord(stored.laneCastAssignments) ? stored.laneCastAssignments : {},
      isRecord(incoming.laneCastAssignments) ? incoming.laneCastAssignments : {},
      visible,
      lanes,
      hiddenIds,
    )
  }
  if (isRecord(stored.laneDefaultVoiceId) || isRecord(incoming.laneDefaultVoiceId)) {
    produced.laneDefaultVoiceId = mergeLaneDefaults(
      isRecord(stored.laneDefaultVoiceId) ? stored.laneDefaultVoiceId : {},
      isRecord(incoming.laneDefaultVoiceId) ? incoming.laneDefaultVoiceId : {},
      visible,
      lanes,
      hiddenIds,
    )
  }

  const next: Record<string, unknown> = {}
  for (const key of Object.keys(stored)) {
    if (key === "voices" || key === "castAssignments" || key === "defaultVoiceId" || key === "laneCastAssignments" || key === "laneDefaultVoiceId") {
      if (key in produced) next[key] = produced[key]
      continue
    }
    next[key] = stored[key]
  }
  for (const key of Object.keys(incoming)) {
    if (key in next || key in produced) continue
    next[key] = incoming[key]
  }
  for (const key of Object.keys(produced)) {
    if (!(key in next)) next[key] = produced[key]
  }
  return next
}
