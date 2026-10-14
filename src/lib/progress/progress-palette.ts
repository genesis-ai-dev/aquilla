// AQU-1764: the one progress palette (Sam, 2026-10-13, "Layout A, softest").
//
// Every progress surface (the Progress card, the plan board, the sidebar's
// file rows and chapter squares, the editor footer and chapter picker, the
// assignment and language bars, the org tables) draws from these five tones,
// defined once as CSS custom properties in `src/index.css`. Text is blue and
// audio is magenta. Within each, the dark step means VALIDATED and the light
// step means DONE BUT NOT VALIDATED YET (translated, or recorded). An AI draft
// nobody has validated is drawn as stripes of the translated colour.
//
// The class names are written out in full and never assembled: Tailwind scans
// the source for literal class names, so a `bg-progress-${tone}` template would
// never be generated.

export type ProgressTone =
  | "textValidated"
  | "textTranslated"
  | "textAi"
  | "audioValidated"
  | "audioRecorded"

/** The fill for a bar part or a swatch, per tone. `textAi` is the stripes. */
export const PROGRESS_BG: Record<ProgressTone, string> = {
  textValidated: "bg-progress-text-validated",
  textTranslated: "bg-progress-text-translated",
  textAi: "bg-progress-ai",
  audioValidated: "bg-progress-audio-validated",
  audioRecorded: "bg-progress-audio-recorded",
}

/**
 * The solid tones as CSS colours, for the few surfaces that set a colour
 * inline because its strength varies per element (the plan board's chapter
 * underlines, the sidebar's chapter squares). AI drafts are stripes, not a
 * colour, so they have no entry.
 */
export const PROGRESS_COLOR = {
  textValidated: "var(--progress-text-validated)",
  textTranslated: "var(--progress-text-translated)",
  audioValidated: "var(--progress-audio-validated)",
  audioRecorded: "var(--progress-audio-recorded)",
} as const satisfies Partial<Record<ProgressTone, string>>

/** One of `PROGRESS_COLOR`'s colours at `alpha` (0–1), over whatever is behind it. */
export function progressColorAt(color: string, alpha: number): string {
  const percent = Math.round(Math.max(0, Math.min(1, alpha)) * 100)
  return `color-mix(in oklab, ${color} ${percent}%, transparent)`
}

/** One part of a progress bar: what it is, and how much of the track it fills. */
export interface ProgressSegment {
  tone: ProgressTone
  /** Width as a percentage (0–100) of the whole track. */
  pct: number
}

function clamp(value: number, max: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(max, value))
}

function parts(total: number, measured: Array<[ProgressTone, number]>): ProgressSegment[] {
  return measured
    // Multiplied first so a whole percentage stays whole: 27 of 100 is 27,
    // where (27 / 100) * 100 is 27.000000000000004.
    .map(([tone, amount]) => ({ tone, pct: (amount * 100) / total }))
    .filter((segment) => segment.pct > 0)
}

/**
 * A text bar's parts, in drawing order: validated, then translated but not
 * validated, then AI drafts nobody has validated.
 *
 * Counts or percentages, as long as `total` is in the same unit; a caller that
 * prints a percentage beside the bar passes that same percentage with
 * `total: 100`, so the bar and the number can never disagree. Each figure is
 * clamped inside the one that contains it (validated within translated, AI
 * drafts within what is translated but not validated, translated within the
 * total), and a part with nothing in it is DROPPED rather than returned at
 * zero width, so no caller draws an empty part or the gap beside it.
 */
export function textProgressSegments({ validated, translated, aiDrafted = 0, total }: {
  validated: number
  translated: number
  /** AI drafts nobody has validated; omit where the data has no such count. */
  aiDrafted?: number
  total: number
}): ProgressSegment[] {
  if (!(total > 0)) return []
  const done = clamp(translated, total)
  const checked = clamp(validated, done)
  const drafted = clamp(aiDrafted, done - checked)
  return parts(total, [
    ["textValidated", checked],
    ["textTranslated", done - checked - drafted],
    ["textAi", drafted],
  ])
}

/**
 * An audio bar's parts, in drawing order: validated, then recorded but not
 * validated. Same units and clamping rules as `textProgressSegments`.
 */
export function audioProgressSegments({ validated, recorded, total }: {
  validated: number
  recorded: number
  total: number
}): ProgressSegment[] {
  if (!(total > 0)) return []
  const done = clamp(recorded, total)
  const checked = clamp(validated, done)
  return parts(total, [
    ["audioValidated", checked],
    ["audioRecorded", done - checked],
  ])
}
