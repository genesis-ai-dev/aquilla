/**
 * What a target language DELIVERS, and the one rule for what counts as done
 * in it (media redesign slice 1; decisions 1–3, Sam's rulings of Oct 22).
 *
 * Each target language row in Project settings → Languages says whether the
 * language delivers Text, Audio, or Text and audio. Every progress number and
 * status word reads this module, so the org dashboard, the project overview,
 * the plan board, the Monday push (and the Airtable push built on it),
 * assignments and the editor can never disagree about one line:
 *
 *   - Text: a line is done when its text is validated. Exactly today's rule.
 *   - Audio: a line is done when its recording is approved by the project's
 *     "Required validators (audio)" (gap 1). Text plays no part.
 *   - Text and audio: a line is done only when BOTH halves are, on the same
 *     line: its text validated and its recording approved.
 *
 * A language nobody has chosen for yet (`null`) counts by text, exactly as
 * every language did before this existed. That is the state every language
 * with "Records audio" on is left in by migration 0186 until Sam picks Text or
 * Text and audio for it, so no existing number moves on deploy.
 *
 * The worker readers import this file directly, so it stays free of fetch,
 * Vite env and `@/` imports.
 */

export const LANE_DELIVERS = ["text", "audio", "text_and_audio"] as const
export type LaneDelivers = (typeof LANE_DELIVERS)[number]

export function isLaneDelivers(value: unknown): value is LaneDelivers {
  return typeof value === "string" && (LANE_DELIVERS as readonly string[]).includes(value)
}

/** A stored or wire value, or null when nothing (valid) has been chosen. */
export function parseLaneDelivers(raw: unknown): LaneDelivers | null {
  return isLaneDelivers(raw) ? raw : null
}

/**
 * A lane row's choice as the client receives it. A server that predates
 * migration 0186 sends no `delivers` at all; there, "Records audio" off was
 * Text, and on was a language nobody has chosen for yet, exactly what the
 * migration writes.
 */
export function laneRowDelivers(lane: {
  delivers?: LaneDelivers | null
  recordsAudio?: boolean
}): LaneDelivers | null {
  if (lane.delivers === undefined) return lane.recordsAudio === true ? null : "text"
  return lane.delivers
}

/** How a lane is counted. Not chosen yet counts by text, as before. */
export function laneCounting(delivers: LaneDelivers | null | undefined): LaneDelivers {
  return delivers ?? "text"
}

/** Does this lane's work include text? */
export function laneCountsText(delivers: LaneDelivers | null | undefined): boolean {
  return laneCounting(delivers) !== "audio"
}

/** Does this lane's DONE rule read its recordings? */
export function laneCountsAudio(delivers: LaneDelivers | null | undefined): boolean {
  return laneCounting(delivers) !== "text"
}

/**
 * The "Records audio" value a choice implies: a language that delivers audio
 * owes it on every file. The setter writes both columns together, so the ~70
 * readers of `lanes.records_audio` (the plan board's audio bars, the dashboard's
 * audio denominator) stay correct without each learning the new column.
 */
export function deliversRecordsAudio(delivers: LaneDelivers): boolean {
  return delivers !== "text"
}

/** One line's state in one lane, as the editor and the per-cell readers see it. */
export interface LaneLineState {
  /** The line has target text in this lane. */
  textFilled: boolean
  /** Its text has the project's required text validators. */
  textValidated: boolean
  /** It has a selected recording in this lane. */
  recorded: boolean
  /** Its recording has the project's required audio validators. */
  audioApproved: boolean
}

/** Has anyone put any of this language's deliverable into the line? */
export function laneLineStarted(
  delivers: LaneDelivers | null | undefined,
  line: Pick<LaneLineState, "textFilled" | "recorded">,
): boolean {
  switch (laneCounting(delivers)) {
    case "audio":
      return line.recorded
    case "text_and_audio":
      return line.textFilled || line.recorded
    default:
      return line.textFilled
  }
}

/** THE rule: is this line done in this language? */
export function laneLineDone(
  delivers: LaneDelivers | null | undefined,
  line: Pick<LaneLineState, "textValidated" | "audioApproved">,
): boolean {
  switch (laneCounting(delivers)) {
    case "audio":
      return line.audioApproved
    case "text_and_audio":
      return line.textValidated && line.audioApproved
    default:
      return line.textValidated
  }
}

/**
 * One lane's counts, as the progress rows give them. The audio figures are
 * measured against `audioTotal` (a dubbing file's cue sheet where it has one,
 * else the file's own lines).
 */
export interface LaneTallies {
  /** Lines (the text denominator). */
  total: number
  /** Lines with target text. */
  filled: number
  /** Lines whose text has the required text validators. */
  validated: number
  /** What the recordings are measured against. */
  audioTotal: number
  /** Lines with a selected recording. */
  recorded: number
  /** Lines whose recording has the required audio validators. */
  audioApproved: number
  /** Lines with BOTH: text validated and recording approved, on the same line. */
  bothApproved: number
}

/** A lane measured by what it delivers. */
export interface LaneMeasure {
  /** Lines the language owes. */
  total: number
  /** Lines with any of its deliverable in them; only `> 0` is a fact for Text and audio (see below). */
  started: number
  /** Lines done, by `laneLineDone`. */
  done: number
  /**
   * The headline figure: what Monday's "Completion %" and the dashboard's first
   * progress column divide by `total`. Text keeps today's figure, the lines
   * with text in them; a language delivering audio reads its done lines, the
   * approved ones (gap 2).
   */
  headline: number
}

/**
 * The aggregate form of `laneLineStarted` / `laneLineDone`. Every counter that
 * works from totals rather than lines goes through here.
 *
 * Text and audio's `started` is the larger of its text and its recordings.
 * The progress rows do not say how many lines carry either, so this is a
 * floor; it is exact for the only question asked of it, "has anything been
 * done yet?".
 */
export function laneMeasure(delivers: LaneDelivers | null | undefined, t: LaneTallies): LaneMeasure {
  switch (laneCounting(delivers)) {
    case "audio":
      return { total: t.audioTotal, started: t.recorded, done: t.audioApproved, headline: t.audioApproved }
    case "text_and_audio":
      return {
        total: t.total,
        started: Math.max(t.filled, t.recorded),
        done: t.bothApproved,
        headline: t.bothApproved,
      }
    default:
      return { total: t.total, started: t.filled, done: t.validated, headline: t.filled }
  }
}

/**
 * The progress projection's joint histogram: one key per (text votes, audio
 * votes) pair, over the lines that have a recording, so "both approved" can be
 * read at any pair of thresholds without reprojecting (the design every
 * validator histogram has used since FRO-279). Keys are `"<text>:<audio>"`.
 */
export const TEXT_AUDIO_BUCKET_SEPARATOR = ":"

/** Lines whose text votes reach `textThreshold` AND whose audio votes reach `audioThreshold`. */
export function bothApprovedFromHistogram(
  raw: unknown,
  textThreshold: number,
  audioThreshold: number,
): number {
  let value: unknown = raw
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw)
    } catch {
      value = null
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return 0
  let count = 0
  for (const [key, amount] of Object.entries(value as Record<string, unknown>)) {
    const [textPart, audioPart] = key.split(TEXT_AUDIO_BUCKET_SEPARATOR)
    const text = Number(textPart)
    const audio = Number(audioPart)
    const lines = Number(amount)
    if (!Number.isInteger(text) || !Number.isInteger(audio)) continue
    if (!Number.isFinite(lines) || lines <= 0) continue
    if (text >= textThreshold && audio >= audioThreshold) count += lines
  }
  return count
}
