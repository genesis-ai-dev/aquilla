// AQU-646 stage 7: the colours an audio track can be painted.
//
// ONE HUE PER TRACK, DRAWN AT THREE ALPHAS. The palette has been through five
// shapes; this one is Sam's own, from a spec he designed and asked to try
// (2026-08-27, `~/Downloads/DAW Track Palette.dc.html`). The seven colours are
// not the interesting part — the rendering model is:
//
//   Gen    33%  a generated voice's chip
//   Take   67%  a recorded take's chip
//   Solid 100%  the gutter accent and the colour dot
//
// SAM MOVED THE WHOLE LADDER DOWN ONE RUNG (2026-08-27, having used it): the
// lane goes back to no colour at all, the value that was the lane becomes the
// generated voice, and the value that was the generated voice becomes the
// recorded take. The 92% body is gone entirely, and the lane stops competing
// with the clips sitting on it.
//
// The two chip values then went to a THIRD and TWO THIRDS (Sam, 2026-08-27) —
// evenly spaced between nothing and the solid, so the three strengths read as
// one ladder rather than as three separately-chosen numbers.
//
// In his words: "each track is one solid hue at even OKLCH spacing. The three
// variants are alpha over the timeline background, so every shade follows the
// theme instead of being redefined for it" — SAME ALPHA VALUES IN BOTH THEMES.
//
// THAT IS WHY THIS FILE IS A FIFTH OF ITS FORMER SIZE. Every earlier palette
// spelled out two full class recipes per hue — `bg-{h}-100/80 text-{h}-800
// dark:bg-{h}-950/70 dark:text-{h}-300`, twice — so a new colour meant eight
// hand-written strings and a theme change meant rewriting all of them. An
// rgba() fill genuinely composites over whatever is behind it, so the theme
// takes care of itself. It works here because this app's dark background is
// `oklch(0.30 0.012 250)`: a mid grey-blue, not near-black (see index.css,
// "dark mode reads as the same material dimmed").
//
// WHAT CARRIES THE RECORDED/GENERATED DISTINCTION, now that a track has one
// hue instead of two: the two alphas, plus the ⟡ sparkle that already rides on
// generated chips. That is exactly the argument stage 2 made when it brought
// the sparkle back — "a track's two tones are deliberately CLOSE in hue… and
// something has to carry the recorded/generated distinction that the tones no
// longer can" — finally executed properly. One hue at two alphas says "same
// track" far better than two hues ever did.
//
// BUILD-LOCAL RENDERING, NOT CONTRACT — the same standing every palette here
// has had. What syncs between clients is a token; what a token looks like is
// decided here, by whichever build happens to be drawing.

/** One selectable hue. Just an identity and a colour now — no class recipes. */
export interface TrackHue {
  /** Persisted inside a track's `color`. Never a colour value. */
  id: string
  labelKey: string
  /** `#rrggbb`, lowercase. Every variant is this at a different alpha. */
  hex: string
}

/**
 * Sam's seven, evenly spaced in OKLCH (his spec, 2026-08-27).
 *
 * NOTE WHAT IS IN HERE THAT NEVER COULD BE BEFORE: Amber and Coral sit in the
 * registers the chip's own warnings use (the amber soft-overflow border, the
 * red at-fault body), and Cyan is near the sky selection ring. Under the old
 * model that made them unusable, because a warning only repainted PART of the
 * chip and an amber track would have hidden an amber warning. Under this one a
 * warning repaints the whole chip and the identity fill stands aside entirely,
 * so the state still changes visibly. It remains the weakest point of the
 * palette and it is Sam's call on screen, which is the standing rule for every
 * colour decision in this PR.
 */
export const TRACK_HUES: readonly TrackHue[] = [
  // Sam tuned green, amber and magenta by eye, and all three moved the same
  // way: MORE SATURATED AND MORE LUMINOUS (mean +19 saturation, +8 brightness
  // in HSB). These three were then taken in the same direction to match, with
  // brightness capped at the 92% he had settled on for amber — the values his
  // own picks never exceeded.
  { id: "cyan", labelKey: "editor.timeline.colorCyan", hex: "#00c3cd" },
  { id: "azure", labelKey: "editor.timeline.colorAzure", hex: "#2489eb" },
  { id: "violet", labelKey: "editor.timeline.colorViolet", hex: "#865deb" },
  // Sam, 2026-08-27, tuning by eye: asked for magenta shifted toward red with
  // more saturation, then set the value himself — a deeper, far more saturated
  // rose than the computed step landed on (S 68%, L 51%).
  { id: "magenta", labelKey: "editor.timeline.colorMagenta", hex: "#da2b84" },
  // …"increase the brightness of amber to about 92%" — HSB brightness 77%→92%,
  // hue and saturation untouched, so it gets more luminous rather than paler.
  { id: "amber", labelKey: "editor.timeline.colorAmber", hex: "#eba720" },
  { id: "green", labelKey: "editor.timeline.colorGreen", hex: "#40c06e" },
]

const BY_ID = new Map(TRACK_HUES.map((h) => [h.id, h]))

/**
 * THE DERIVED ROWS' OWN HUES — fixed, and not in the palette above.
 *
 * These are not choices, they are statements about what the row IS, which is
 * why they are unpickable and why Sam has ruled twice that they do not change
 * (2026-08-22: "do not be changeable... we've talked about this many times").
 * What stage 7 changes is only how they are EXPRESSED: they used to be
 * hand-written Tailwind pairs with their own `dark:` variants, and now they run
 * through the same hue-plus-alpha vocabulary as everything else, so the gutter
 * and the lanes read as one system instead of two.
 *
 *  · Source text — a neutral. It is the one row that is not about a voice.
 *  · Source audio — aquilla blue, the app's own, kept deliberately clear of the
 *    palette's Azure so a track wearing Azure is never mistaken for it.
 *  · Target text — the same green as an untouched dub row, because it is the
 *    text half of the same side of the file. They are told apart by ALPHA now
 *    rather than by a paler hue, which is exactly what the old "emerald, but
 *    pale" comment was reaching for before there was a way to say it.
 */
const DERIVED_HUES: Record<string, string> = {
  "source-subtitles": "#8b93a3",
  "source-audio": "#0e9bd6",
  "target-subtitles": "#40c06e",
}

/**
 * The hue a row is drawn in: its own if it may be coloured, otherwise the one
 * its KIND is fixed to. One entry point, so no caller has to know which rows
 * are pickable.
 */
export function hueForTrack(kind: string, color: string | null | undefined): string {
  if (isColorableKind(kind)) return parseTrackHue(color)
  return DERIVED_HUES[kind] ?? DEFAULT_HUE.hex
}

/**
 * SOURCE AUDIO IS DRAWN LIGHTER THAN EVERYTHING ELSE (Sam, 2026-08-27): its
 * fill drops 33% → 24% and its hover 18% → 12%.
 *
 * It earns the exception by being the one row you are not working ON. It is
 * reference — the film's own speech, one chip per heard line, hundreds of them
 * across an episode and continuous for minutes at a stretch — so at the shared
 * strength it reads as a solid band and competes with the dub row underneath,
 * which is the row that matters. Every other row is either sparse (takes) or
 * untinted (text).
 */
const ALPHA_BY_KIND: Record<string, Partial<TrackAlpha>> = {
  "source-audio": { hover: 0.12, generated: 0.24 },
}

/** The custom properties for a row, resolved from its kind and its colour. */
export function trackHueVarsFor(
  kind: string,
  color: string | null | undefined,
): Record<string, string> {
  return hueVarsFromHex(hueForTrack(kind, color), { ...ALPHA, ...ALPHA_BY_KIND[kind] })
}

/** An untouched track. Green because it is the nearest thing in this palette to
 *  the emerald every dub row has worn since long before any of this. */
export const DEFAULT_HUE = BY_ID.get("green")!

/** The alphas, and they are the whole design. Named for what they mean rather
 *  than what they are, because the numbers are Sam's and the meanings are the
 *  contract between this file and the lane. */
/** The four strengths a row is drawn at. */
export interface TrackAlpha {
  hover: number
  generated: number
  take: number
}

export const ALPHA: TrackAlpha = {
  /**
   * THE HOVER WASH, for anything on a row that answers to the pointer — a real
   * source-audio chip and the dotted placeholder between two of them alike
   * (Sam, 2026-08-27). It is the lightest rung, below even a generated voice,
   * because a hover is a hint about what the pointer is over rather than a
   * statement about what the clip IS.
   *
   * This is the value the LANE briefly wore before the ladder moved down; it
   * comes back here, which leaves the four strengths evenly spaced: 18 to
   * point at something, 33 to say it was generated, 67 to say it was
   * performed, 100 to name the row itself.
   */
  hover: 0.18,
  /** A generated voice — lighter, because it is derived rather than performed. */
  generated: 0.33,
  /** A recorded take. */
  take: 0.67,
}

// ── Reading a stored value ──────────────────────────────────────────────────
//
// THE WIRE FORMAT'S SHAPE IS UNCHANGED, which is what makes this free. The
// server validates a track colour as `/^[a-z0-9][a-z0-9-]{0,31}$/` — a pattern
// rather than an enum, chosen so a newer client's tokens round-trip through an
// older worker. A preset id (`cyan`) and a bare hex (`00c3cd`) both fit, so
// there is no worker deploy and no migration, again.

/**
 * `00c3cd` → `#00c3cd`. Anything else → null, including a preset id.
 *
 * THE MENU NO LONGER WRITES THESE — it writes preset ids — but reading them
 * stays, because a colour picker briefly shipped in this branch and Sam's own
 * dev database carries values it wrote. Dropping the branch would silently
 * repaint those tracks; keeping it costs one regex.
 */
function literalHex(token: string): string | null {
  return /^[0-9a-f]{6}$/.test(token) ? `#${token}` : null
}

/**
 * The hue a stored value means, as `#rrggbb`.
 *
 * Accepts everything that has ever been written into this field:
 *   · a preset id            `cyan`
 *   · a bare hex             `00c3cd`   (the picker's output)
 *   · a LEGACY two-part pair `green-teal` → takes the first half and drops the
 *     second, because the model has no second axis any more. `green` survives
 *     as a hue id, so Sam's own stored value keeps meaning something close to
 *     what it meant; the retired ids (teal, indigo, fuchsia, slate) fall back
 *     to the default, which is precisely what a pattern-not-enum format is for.
 */
export function parseTrackHue(color: string | null | undefined): string {
  if (!color) return DEFAULT_HUE.hex
  const head = color.indexOf("-") === -1 ? color : color.slice(0, color.indexOf("-"))
  return literalHex(head) ?? BY_ID.get(head)?.hex ?? DEFAULT_HUE.hex
}

/** `#00c3cd` at `a` → `rgba(0, 176, 185, a)`. */
export function hexToRgba(hex: string, alpha: number): string {
  const n = Number.parseInt(hex.replace(/^#/, ""), 16)
  if (!Number.isFinite(n)) return `rgba(0, 0, 0, ${alpha})`
  return `rgba(${(n >> 16) & 0xff}, ${(n >> 8) & 0xff}, ${n & 0xff}, ${alpha})`
}

/**
 * THE HUE AS CUSTOM PROPERTIES, WHICH IS THE TRICK THIS STAGE TURNS ON.
 *
 * An arbitrary colour can never be a Tailwind class — Tailwind emits only what
 * it can see as a literal while scanning source — so stage 6H rev 2 put picked
 * colours in an inline `style`. An inline style beats EVERY class, including
 * the chip's state layers, whose entire design is that they win by sitting
 * later in the same `cn()`. That forced a gate withholding the fill in every
 * warning state, and getting the gate wrong (it read `overflow == null` when
 * the value is the string `"none"`) would have silenced every warning on a
 * coloured track.
 *
 * Custom properties are the way out: they set no colour property, so they beat
 * nothing, and a LITERAL class can reference one. `bg-[color:var(--tl-track-
 * body)]` is a source literal Tailwind emits, whose value happens to vary —
 * and tailwind-merge treats it as an ordinary `bg-color`, so
 * `bg-red-100/80` after it still wins. Verified against this repo's own copy:
 *
 *     twMerge('bg-[color:var(--x)] bg-red-100/80')  →  'bg-red-100/80'
 *
 * So the gate is gone and the warnings beat the tint by the original design.
 *
 * THEY ALSO INHERIT, which is why this is set ONCE on the lane: every chip,
 * trim grip (`bg-current`), sparkle and waveform (`fill-current`) inside it
 * reads the same hue with no prop threading at all.
 */
export function trackHueVars(color: string | null | undefined): Record<string, string> {
  return hueVarsFromHex(parseTrackHue(color), ALPHA)
}

function hueVarsFromHex(hex: string, alpha: TrackAlpha): Record<string, string> {
  return {
    "--tl-track-hue": hex,
    "--tl-track-hover": hexToRgba(hex, alpha.hover),
    "--tl-track-gen": hexToRgba(hex, alpha.generated),
    "--tl-track-take": hexToRgba(hex, alpha.take),
  }
}

// The class vocabulary, in the one module that also owns the variables so the
// two can never drift. EVERY ONE OF THESE IS A LITERAL and has to stay one:
// a constructed `bg-[color:var(--${name})]` produces no CSS at all, silently.

/**
 * THE LANE HAS NO COLOUR. (Sam, 2026-08-27: "make lane colors back to white, or
 * just fully transparent.") It is left as a real, empty constant rather than
 * deleted so the next person to reach for a lane wash finds this note first:
 * the tint competed with the very chips it sat behind, which is why it went.
 */
export const TRACK_LANE_TINT_CLASS = ""
// THE OUTLINE IS THE HUE AT FULL STRENGTH ON BOTH (Sam, 2026-08-27), and the
// fill is the wash. It gives an audio chip a definite edge instead of a soft
// block that dissolves into the row — which matters most where two chips abut,
// and where a generated voice at 33% was barely a shape at all. It is also the
// same solid the gutter accent, the colour dot and the dashed placeholder's
// edge already use, so one hue now says "this track" at four places on a row.
/** A recorded take: the hue at 67%, outlined in the hue itself. */
export const TRACK_CHIP_TAKE_CLASS =
  "border-[color:var(--tl-track-hue)] bg-[color:var(--tl-track-take)] text-foreground"
/** A generated voice: the same hue at 33% — derived, so lighter — outlined the
 *  same way, because it belongs to the same track. */
export const TRACK_CHIP_GENERATED_CLASS =
  "border-[color:var(--tl-track-hue)] bg-[color:var(--tl-track-gen)] text-foreground"
/** The gutter's 4px identity bar. A CLASS ON THE ROW'S ROOT, never a new
 *  element — see the note at its call site in TimelineEditor. */
export const TRACK_ACCENT_CLASS = "border-l-4 border-l-[color:var(--tl-track-hue)]"
/** What anything on a coloured row does under the pointer. */
export const TRACK_HOVER_CLASS = "hover:bg-[color:var(--tl-track-hover)]"
/** The gutter dot, at full strength. */
export const TRACK_DOT_CLASS = "bg-[color:var(--tl-track-hue)]"
/**
 * A PLACEHOLDER chip — a stretch the row could hold something in but does not.
 *
 * The lower rung of the ladder, and deliberately below even the generated
 * wash: no fill at rest, just a dashed edge in the row's hue, filling to the
 * HOVER alpha only under the pointer. A block of colour at rest would
 * overstate an absence, which is what the old `bg-sky-50/30` was quietly
 * apologising for by being nearly invisible.
 */
export const TRACK_DASH_CLASS =
  "border-dashed border-[color:var(--tl-track-hue)] hover:bg-[color:var(--tl-track-hover)]"

/** The chip's identity classes for one clip. */
export function trackChipClass(kind: "take" | "generated"): string {
  return kind === "take" ? TRACK_CHIP_TAKE_CLASS : TRACK_CHIP_GENERATED_CLASS
}

// 2026-08-27 (Sam): the preview PROGRESS FILL. While a chip's own preview
// plays, its fill becomes a hard-split gradient at the playhead — played side
// at the chip's normal rung, unplayed side down at the hover rung ("not yet").
// The SoundCloud/voice-note pattern, spoken in this palette's own vocabulary:
// no new colour and no free-floating opacity, just the ladder. `--tl-play-x`
// is written per frame by the chip's playhead ride; its 0px default means
// "pressed, nothing sounded yet", which dims the whole chip — honest press
// feedback while the decode is still in flight. `bg-transparent` mutes the
// identity colour underneath, because the gradient's stops are the same
// semi-transparent washes and would otherwise stack on it.
export const TRACK_CHIP_PLAYING_TAKE_CLASS =
  "bg-transparent bg-[image:linear-gradient(to_right,var(--tl-track-take)_var(--tl-play-x,0px),var(--tl-track-hover)_var(--tl-play-x,0px))]"
export const TRACK_CHIP_PLAYING_GENERATED_CLASS =
  "bg-transparent bg-[image:linear-gradient(to_right,var(--tl-track-gen)_var(--tl-play-x,0px),var(--tl-track-hover)_var(--tl-play-x,0px))]"

/** The playing chip's fill — a progress split in the chip's own two rungs. */
export function trackChipPlayingClass(kind: "take" | "generated"): string {
  return kind === "take" ? TRACK_CHIP_PLAYING_TAKE_CLASS : TRACK_CHIP_PLAYING_GENERATED_CLASS
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
