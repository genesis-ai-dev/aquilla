// AQU-2511 — ONE answer to "which voice does this line speak with", wherever a
// generate asks.
//
// The lane projection has existed since AQU-2037/AQU-2038, and the surfaces
// that LIST or NAME a voice all read it: `useProjectTts` resolves the open
// lane once and ProjectWorkspace hands the result down as `audioProject`
// (`project` with `ttsSettings = tts.laneSettings`). The generate path did not.
// It read `project.ttsSettings` — the project-wide blob — so the picker's
// choice, which is stored in `laneCastAssignments[lane][cellId]`, was invisible
// to it: pressing Generate in the cell dialog came back in the project default
// while the toast beside it named the voice that was picked. Two lookups, one
// screen, two answers (Joel, 2026-11-10).
//
// So the projection is applied HERE, inside the generate path, from the lane
// tag that path already carries. A caller that hands over the lane view
// already (every audio surface going through `audioProject`) is unaffected —
// the projection is idempotent — and a caller that forgets becomes
// lane-correct anyway. That is the point: the resolution cannot be forgotten
// at a call site, which is how this bug got in.
//
// NEVER WRITE THIS BACK. It is a read view over one lane, exactly as
// `laneScopedTtsSettings` and `laneTtsSettings` are; storing it would delete
// every other lane's voices and cast.

import { laneTtsSettings } from "./lane-cast"
import { laneScopedTtsSettings } from "./voice-lanes"
import { findVoice, getVoiceLibrary } from "./voices"
import { laneIdForTag } from "@/lib/lanes/active-lane-choice"
import type { ProjectRecord, ProjectTtsSettings } from "@/lib/parsers/types"

/**
 * `settings` as the lane tagged `laneTag` sees them: its voices (AQU-2037),
 * with `castAssignments` and `defaultVoiceId` resolved for that lane — its own
 * answers over the project-wide fallback (AQU-2038).
 *
 * `laneTag` is the legacy tag the cast is stored under (`''`/absent is the
 * default lane — the same key `cells`/`lanes` have used since AQU-538), and
 * the lane ROW id the voice library is scoped by is looked up from it, the way
 * the workspace does (`laneIdForTag`). A project with no lane rows, or a tag
 * that names none, is left project-wide — which is the pre-lane behaviour.
 */
export function laneVoiceSettings(
  settings: ProjectTtsSettings | undefined,
  lanes: ProjectRecord["lanes"],
  laneTag: string | null | undefined,
): ProjectTtsSettings | undefined {
  const tag = laneTag ?? ""
  const laneId = lanes ? laneIdForTag(tag, lanes.filter((lane) => lane.role === "target")) : null
  return laneTtsSettings(laneScopedTtsSettings(settings, laneId), tag)
}

/**
 * `view` with `voiceId` findable in its library, borrowed from `all` (the
 * project-wide settings) when the lane has no such voice.
 *
 * For an EXPLICIT voice only. A caller that names a voice is giving an
 * instruction — "say it in this one" — not reading an assignment, and the lane
 * library is a filter on assignments: scoping an explicit pick away would
 * silently swap it for the lane default, which is the same class of bug
 * AQU-2511 is about. Assignments stay scoped, which is AQU-2037's rule.
 */
export function withVoiceAvailable(
  view: ProjectTtsSettings | undefined,
  all: ProjectTtsSettings | undefined,
  voiceId: string | undefined,
): ProjectTtsSettings | undefined {
  if (!voiceId || findVoice(view, voiceId)) return view
  const voice = findVoice(all, voiceId)
  if (!voice) return view
  return { ...(view ?? {}), voices: [...getVoiceLibrary(view), voice] }
}
