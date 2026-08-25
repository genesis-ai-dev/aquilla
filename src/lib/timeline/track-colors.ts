// AQU-646: the colours an audio track can be painted.
//
// SIX HUES, TWO WEIGHTS (Sam, 2026-08-25). The palette has been through four
// shapes and this is the one that survived contact with using it:
//
//   1. Six frozen two-tone pairs — you took a pair or left it.
//   2. Six hues on each of two independent axes (stage 3c).
//   3. GREEN AND PURPLE, on each of two axes. Sam: *"reduce the colors to just
//      those two… with the current default green being considered the 'lighter
//      green' and the current default purple being considered a 'darker
//      purple', and then you just need to come up with a dark green version and
//      a light purple version."*
//
// PRIMARY IS THE RECORDED TAKE, SECONDARY IS THE GENERATED VOICE, and each is
// chosen separately. Every primary is drawn lighter than every secondary, so
// the same hue on both axes still reads as two tones.
//
// THE DEFAULT IS NOW AN ORDINARY SELECTION, WHICH IS THE POINT OF THIS SHAPE.
// The old palette needed a "Default" item because the untinted look — the
// emerald/violet that shipped long before any of this — was not expressible in
// the palette itself. Anchoring the two new weights on those exact strings
// makes it expressible: green-as-primary IS the shipped emerald, purple-as-
// secondary IS the shipped violet, so a track that has never been touched shows
// its ticks on Green and Purple like any other, and Sam's *"there shouldn't be
// a default button"* falls out rather than being special-cased.
//
// BUILD-LOCAL RENDERING, NOT CONTRACT — the same standing as TRACK_RENDER in
// TimelineEditor. What syncs between clients is an id; what an id looks like is
// decided here, by whichever build happens to be drawing. Storing hues in the
// data would freeze one build's palette into every project and make a restyle a
// migration.
//
// EVERY CLASS STRING IS A LITERAL, AND HAS TO BE. Tailwind v4 generates only the
// classes it can find as literal substrings while scanning source, so a
// constructed `bg-${hue}-100/80` produces no CSS at all and the chip renders
// untinted — the failure is silent, cosmetic and easy to mistake for a data
// problem. Do not refactor this table into a template.
//
// THE HUES THE CHIP'S STATE LAYERS HAVE ALREADY CLAIMED are still off limits,
// and the constraint outlived the palette that prompted it:
//   · amber-500  — the soft-overflow border ("this take runs long")
//   · red-500    — the at-fault body, which repaints bg-red-100/80 text-red-800
//   · sky-500    — both the selection ring AND the Source-audio gutter dot
// A track painted in any of them is a track whose warnings are invisible.
// `track-colors.test.ts` fails if one is ever added back.

/** One selectable hue, drawn at either weight depending on which axis picked it. */
export interface TrackHue {
  /** Persisted inside a track's `color`. Never colour values. */
  id: string
  /** i18n key, never copy. */
  labelKey: string
  /** Drawn when this hue is the PRIMARY — the lighter of the two weights. */
  light: string
  /** Drawn when this hue is the SECONDARY — the heavier of the two. */
  dark: string
  /** Solid fill for the picker's circle, at each weight. The chip tints above
   *  are five-utility recipes and would read as washed-out blobs at 14px; a
   *  picker swatch has to be the saturated statement of the hue. */
  swatchLight: string
  swatchDark: string
}

/**
 * THE TWO ANCHORS ARE COPIED BYTE FOR BYTE FROM WHAT SHIPPED, and that is the
 * whole reason the default needs no special case:
 *
 *   green.light   = the emerald a recorded take has always worn
 *   violet.dark   = the violet a generated voice has always worn
 *
 * If either drifts, every project in the app silently gets a new look — Sam,
 * 2026-08-22: "our green purple pairing for the default first track should
 * remain as is until manually changed." The test pins both literals.
 *
 * THE RECIPES, written out once so a reviewer can check the table by eye:
 *
 *   light  border-{h}-500/60 bg-{h}-100/80 text-{h}-800 dark:bg-{h}-950/70 dark:text-{h}-300
 *   dark   border-{h}-700/70 bg-{h}-300/80 text-{h}-900 dark:bg-{h}-800/70  dark:text-{h}-100
 *
 * The light recipe IS the shipped one, which is what makes `green.light` fall
 * out of the table rather than being an exception to it.
 *
 * VIOLET IS THE ONE HUE THAT BREAKS BOTH RECIPES, deliberately and unavoidably.
 * The two shipped tints sit at the SAME point on the Tailwind ramp (both
 * `-100/80`), so once Sam declared green the lighter and violet the darker
 * (2026-08-25) the two bands could no longer be one fixed pair of ramp steps
 * across every hue. Violet's dark end is the shipped `-100/80` — one band below
 * every other hue's dark — and its light end is pushed down to `-50` with a
 * lighter border and text so it still clears its own dark.
 *
 * CONSEQUENCE WORTH KNOWING: violet reads paler than the other five at both
 * weights, and its two weights are closer together than theirs. That is the
 * price of keeping the shipped generated-voice tint exactly. Raising violet's
 * dark to `-300/80` would even the palette out at the cost of every existing
 * project's TTS chips shifting a shade — a one-line change if Sam prefers it.
 *
 * NOTE WHAT IS ABSENT FROM EVERY RECIPE, deliberately: no `ring-*`, no
 * `border-l-*`, no `opacity-*`. Those belong to the state layers that come
 * AFTER the palette in the chip's class list, and tailwind-merge resolves
 * last-wins per utility group — so introducing one here would let a colour
 * quietly beat a warning.
 */
export const TRACK_HUES: readonly TrackHue[] = [
  {
    id: "green",
    labelKey: "editor.timeline.colorGreen",
    // ANCHOR — the shipped recorded-take tint, unchanged.
    light: "border-emerald-500/60 bg-emerald-100/80 text-emerald-800 dark:bg-emerald-950/70 dark:text-emerald-300",
    dark: "border-emerald-700/70 bg-emerald-300/80 text-emerald-900 dark:bg-emerald-800/70 dark:text-emerald-100",
    swatchLight: "bg-emerald-400",
    swatchDark: "bg-emerald-600",
  },
  {
    id: "teal",
    labelKey: "editor.timeline.colorTeal",
    light: "border-teal-500/60 bg-teal-100/80 text-teal-800 dark:bg-teal-950/70 dark:text-teal-300",
    dark: "border-teal-700/70 bg-teal-300/80 text-teal-900 dark:bg-teal-800/70 dark:text-teal-100",
    swatchLight: "bg-teal-400",
    swatchDark: "bg-teal-600",
  },
  {
    id: "indigo",
    labelKey: "editor.timeline.colorIndigo",
    light: "border-indigo-500/60 bg-indigo-100/80 text-indigo-800 dark:bg-indigo-950/70 dark:text-indigo-300",
    dark: "border-indigo-700/70 bg-indigo-300/80 text-indigo-900 dark:bg-indigo-800/70 dark:text-indigo-100",
    swatchLight: "bg-indigo-400",
    swatchDark: "bg-indigo-600",
  },
  {
    id: "violet",
    labelKey: "editor.timeline.colorViolet",
    light: "border-violet-300/60 bg-violet-50 text-violet-700 dark:bg-violet-950/40 dark:text-violet-300",
    // ANCHOR — the shipped generated-voice tint, unchanged.
    dark: "border-violet-500/60 bg-violet-100/80 text-violet-800 dark:bg-violet-950/70 dark:text-violet-300",
    swatchLight: "bg-violet-400",
    swatchDark: "bg-violet-600",
  },
  {
    id: "fuchsia",
    labelKey: "editor.timeline.colorFuchsia",
    light: "border-fuchsia-500/60 bg-fuchsia-100/80 text-fuchsia-800 dark:bg-fuchsia-950/70 dark:text-fuchsia-300",
    dark: "border-fuchsia-700/70 bg-fuchsia-300/80 text-fuchsia-900 dark:bg-fuchsia-800/70 dark:text-fuchsia-100",
    swatchLight: "bg-fuchsia-400",
    swatchDark: "bg-fuchsia-600",
  },
  {
    id: "slate",
    labelKey: "editor.timeline.colorSlate",
    light: "border-slate-500/60 bg-slate-100/80 text-slate-800 dark:bg-slate-950/70 dark:text-slate-300",
    dark: "border-slate-700/70 bg-slate-300/80 text-slate-900 dark:bg-slate-800/70 dark:text-slate-100",
    swatchLight: "bg-slate-400",
    swatchDark: "bg-slate-600",
  },
]

const BY_ID = new Map(TRACK_HUES.map((h) => [h.id, h]))

/** Green primary, violet secondary — the look every untouched track has always
 *  had, now spelled in the palette's own vocabulary rather than beside it. */
export const DEFAULT_PRIMARY = TRACK_HUES.find((h) => h.id === "green")!
export const DEFAULT_SECONDARY = TRACK_HUES.find((h) => h.id === "violet")!

export interface TrackColorChoice {
  primary: TrackHue
  secondary: TrackHue
}

/**
 * Read a stored `color` into its two halves.
 *
 * THE WIRE FORMAT IS `"{primary}-{secondary}"` — e.g. `"green-violet"` — and it
 * needs no contract change, which is the load-bearing fact about this whole
 * design. The server validates `color` against `/^[a-z0-9][a-z0-9-]{0,31}$/`
 * (file-track-set.ts), deliberately a PATTERN and not an enum precisely so a
 * newer client's ids round-trip through an older worker. A hyphenated pair
 * passes it unchanged, and the longest value the palette can produce —
 * `"fuchsia-fuchsia"` — is 15 of the 32 characters. No worker deploy, no
 * migration.
 *
 * FALLS BACK RATHER THAN FAILING, for the same reason: a hue this build cannot
 * name draws as the default. The track is still there, still named, still
 * playing, just not in someone else's colour, and their stored value is
 * untouched so their client keeps showing it correctly. That also covers every
 * id the two earlier palettes wrote (`teal`, `lime`, `indigo`…), which is safe
 * because neither ever shipped — the only data in those shapes is on a
 * developer's machine.
 *
 * A BARE HUE (`"green"`) means that hue on both axes.
 */
export function parseTrackColor(color: string | null | undefined): TrackColorChoice {
  if (!color) return { primary: DEFAULT_PRIMARY, secondary: DEFAULT_SECONDARY }
  const split = color.indexOf("-")
  if (split === -1) {
    const both = BY_ID.get(color)
    return both ? { primary: both, secondary: both } : { primary: DEFAULT_PRIMARY, secondary: DEFAULT_SECONDARY }
  }
  return {
    primary: BY_ID.get(color.slice(0, split)) ?? DEFAULT_PRIMARY,
    secondary: BY_ID.get(color.slice(split + 1)) ?? DEFAULT_SECONDARY,
  }
}

/** …and the inverse. Always writes both halves, so a stored value is complete
 *  and no reader has to guess what a missing one meant. */
export function formatTrackColor(primary: string, secondary: string): string {
  return `${primary}-${secondary}`
}

/** The chip tint for one clip on a track of this colour. */
export function trackChipTint(color: string | null | undefined, kind: "take" | "generated"): string {
  const { primary, secondary } = parseTrackColor(color)
  return kind === "take" ? primary.light : secondary.dark
}

/** The gutter dot beside the track's name — the primary hue's saturated swatch,
 *  which for an untouched track is the `bg-emerald-600` it has always been. */
export function trackDot(color: string | null | undefined): string {
  return parseTrackColor(color).primary.swatchDark
}

/** Whether a track of this KIND may be recoloured at all.
 *
 *  Only audio. Source subtitles keeps its grey and source audio its aquilla
 *  blue, and both are deliberate rather than unassigned (Sam, 2026-08-22: "do
 *  not be changeable ... we've talked about this many times"). Target subtitles
 *  is pale emerald for the same reason — it is the text half of the dub row,
 *  and saying so in colour is the point of it.
 *
 *  The DERIVED target-audio row is included, and always has been: it is a dub
 *  row like any other and Sam confirmed it on 2026-08-24. */
export function isColorableKind(kind: string): boolean {
  return kind === "target-audio" || kind === "audio"
}
