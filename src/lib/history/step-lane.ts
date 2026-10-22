/**
 * Which language a history step belongs to. (Decision 11, 2026-10-20: one
 * history per person and project, not per language.)
 *
 * Takes, translations and approvals live in one language: undoing them only
 * makes sense with that language open, and the History panel names it. Rows,
 * tracks, settings, the film, cue links, characters and source text are shared
 * by every language, so their steps belong to none and run wherever you are.
 */

/** Step kinds whose change every language shares. */
const LANE_FREE_KINDS: ReadonlySet<string> = new Set([
  "row.retime",
  "row.hidden",
  "row.add",
  "row.remove",
  "track.patch",
  "settings.project",
  "film.link",
  "cue.link",
  "cast.assign",
  "lines.fromRecording",
  "file.importRecording",
  "source.text",
])

/**
 * The language a step made now belongs to: `lane` (the open one) unless the
 * kind is shared by every language, in which case undefined. A group belongs
 * to the language of its parts.
 */
export function stepLane(kind: string, data: unknown, lane: string): string | undefined {
  if (kind === "group") {
    const steps = (data as { steps?: ReadonlyArray<{ lane?: string }> } | null)?.steps ?? []
    return steps.find((s) => s.lane !== undefined)?.lane
  }
  if (LANE_FREE_KINDS.has(kind)) return undefined
  // Source text is shared; only a translation belongs to its language.
  if (kind === "text.commit" && (data as { side?: string } | null)?.side === "source") return undefined
  return lane
}
