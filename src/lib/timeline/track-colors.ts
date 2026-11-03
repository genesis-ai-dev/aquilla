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

import { WAVE_C, hexToOklch, oklchCss, playLineColorCss, stripColorCss, waveColorCss } from "./track-oklch"

/** One selectable hue. Just an identity and a colour now — no class recipes. */
export interface TrackHue {
  /** Persisted inside a track's `color`. Never a colour value. */
  id: string
  labelKey: string
  /** `#rrggbb`, lowercase. Every variant is this at a different alpha. */
  hex: string
}

/**
 * Sam's six, evenly spaced in OKLCH (his spec, 2026-08-27; Coral was cut the
 * same day).
 *
 * WHAT IS IN HERE THAT NEVER COULD BE BEFORE — and the honest limit of it.
 * Amber sits in the register the soft-overflow warning uses, and Cyan near the
 * sky selection ring. For the RED at-fault state this is genuinely solved: it
 * repaints the whole chip body, so no hue can hide it.
 *
 * THE AMBER ONE IS NOT SOLVED, and this docstring used to claim otherwise.
 * Soft-overflow is border-and-ring only, while a coloured chip already sets
 * `border-[color:var(--tl-track-hue)]` — so on the Amber hue the warning is
 * amber on amber. The `cn()` ordering is right and the warning does win the
 * border group; it just wins it with nearly the same colour. Reviewed and
 * deliberately deferred (Sam, 2026-08-27: "leave it as is for now"), together
 * with making that warning's threshold configurable. The fix that retires the
 * class rather than this one collision is to give the warning something that
 * is not a border colour — a dashed edge, or the `»` glyph the truncation
 * states already use.
 *
 * Contrast, also reviewed and accepted the same day: over the dark ground the
 * .67 take rung leaves the waveform at 2.9:1 on Cyan and 2.9:1 on Amber, under
 * the 3:1 guideline for non-text. It carries a waveform and small glyphs
 * rather than words — the rung that carries words is .33, which clears 5.5:1
 * on every hue — and forcing all six past 4.5:1 would need the take alpha down
 * at .43, on top of generated's .33, which would flatten the ladder. Left as
 * a deliberate call.
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
  // rose than the computed step landed on (S 68%, L 51%). Sam, Oct 28:
  // "Magenta needs a small nudge away from red" — hue 355.7 → 350.5, the
  // lightness and chroma unchanged (#da2b84 → #d62e90), the same size of step
  // the green took. Tracks store the id "magenta", so every one follows.
  { id: "magenta", labelKey: "editor.timeline.colorMagenta", hex: "#d62e90" },
  // …"increase the brightness of amber to about 92%" — HSB brightness 77%→92%,
  // hue and saturation untouched, so it gets more luminous rather than paler.
  { id: "amber", labelKey: "editor.timeline.colorAmber", hex: "#eba720" },
  // AQU-2235 (Sam, Oct 25, board 53): green moved to the recording progress
  // bar's hue at its old lightness, with the chroma eased just enough to stay
  // on screen — so its strip, dot, ground, frame and waveform all share one
  // hue instead of an olive waveform on a green chip. Sam, Oct 28: "back the
  // green hue a little back away from blue… just like a hair" — emerald-500's
  // 162.5 read ever so slightly teal, so it sits at hue 157.0, the lightness
  // and chroma unchanged (#0cc187 → #23c179); the recording window's timing
  // bar moved with it. Was #40c06e before Oct 25. Tracks store the id
  // "green", never the hex, so every stored track keeps its colour id and
  // simply draws the new green.
  { id: "green", labelKey: "editor.timeline.colorGreen", hex: "#23c179" },
]

const BY_ID = new Map(TRACK_HUES.map((h) => [h.id, h]))

/**
 * The recorder's timing bar while a take is inside its window (AQU-2235; Sam,
 * Oct 28): the green track's hue at emerald-500's own lightness and chroma,
 * the bar's green until then. Derived from the track rather than written out,
 * so the next change to the palette's green moves the timing bar with it.
 */
export const RECORDING_OK_GREEN = oklchCss(0.696, 0.149, hexToOklch(BY_ID.get("green")!.hex).h)
/** The palette's own hexes: only these get the strip colour (AQU-2235). */
const PALETTE_HEXES: ReadonlySet<string> = new Set(TRACK_HUES.map((h) => h.hex))

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
  // The palette's own green, BY REFERENCE (AQU-2235): "the same green as an
  // untouched dub row" was a copied hex, so moving the green would have split
  // the two halves of the dub side apart.
  "target-subtitles": BY_ID.get("green")!.hex,
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
  "source-audio": { hover: 0.12, hoverFill: 0.36, generated: 0.24 },
}

/**
 * The film row's hue (AQU-2253, board 56's `FILM_HUE`): a dark neutral for its
 * accent bar and dot. The film row is not a track a user can colour, move or
 * rename — it is pinned at the top whenever a film is linked — so it is not a
 * kind in the track contract either; it simply has its own hue.
 */
export const FILM_TRACK_HUE = "#43464e"

export function filmTrackHueVars(): Record<string, string> {
  return hueVarsFromHex(FILM_TRACK_HUE, ALPHA)
}

/** The custom properties for a row, resolved from its kind and its colour. */
export function trackHueVarsFor(
  kind: string,
  color: string | null | undefined,
): Record<string, string> {
  const hex = hueForTrack(kind, color)
  return cachedHueVars(`${kind}:${hex}`, hex, ALPHA_BY_KIND[kind] ? { ...ALPHA, ...ALPHA_BY_KIND[kind] } : ALPHA)
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
  hoverFill: number
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
  /**
   * THE SAME HINT, ON SOMETHING THAT IS ALREADY FILLED (2026-08-27).
   *
   * `hover` above is the lightest rung on purpose, and that is right for an
   * EMPTY surface — the dotted placeholder between two source chips has
   * nothing to be lighter than. Applied to a chip that already carries a fill
   * it is a bug: both are `background-color`, so the hover REPLACES the fill
   * rather than adding to it, and pointing at a chip made it fainter. Every
   * row had it; source audio, whose ladder is lighter still, is where it was
   * visible (.24 → .12, a chip that halves under the pointer).
   *
   * So the rule this rung exists to keep, and which its test states as a
   * property rather than a number: A HOVER IS NEVER FAINTER THAN WHAT IT
   * COVERS. One step above `generated`, which is the strongest fill any
   * hoverable chip wears — a take chip is not hoverable this way.
   */
  hoverFill: 0.45,
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
  const hex = parseTrackHue(color)
  return cachedHueVars(hex, hex, ALPHA)
}

/**
 * Every row, every lane and every takes-list row asks for these on every
 * render, and since AQU-2235 each answer costs three OKLab conversions and up
 * to three P3 gamut walks. It depends only on the colour and the row's kind's
 * alphas, so each one is worked out once and kept — a handful of entries, the
 * palette's six and whatever few other colours a project uses. Frozen, because
 * one object is now handed to every caller.
 */
const HUE_VARS = new Map<string, Record<string, string>>()
function cachedHueVars(key: string, hex: string, alpha: TrackAlpha): Record<string, string> {
  let vars = HUE_VARS.get(key)
  if (!vars) {
    vars = Object.freeze(hueVarsFromHex(hex, alpha)) as Record<string, string>
    HUE_VARS.set(key, vars)
  }
  return vars
}

function hueVarsFromHex(hex: string, alpha: TrackAlpha): Record<string, string> {
  const strip = stripColorFor(hex)
  return {
    "--tl-track-hue": hex,
    "--tl-track-hover": hexToRgba(hex, alpha.hover),
    "--tl-track-hover-fill": hexToRgba(hex, alpha.hoverFill),
    "--tl-track-gen": hexToRgba(hex, alpha.generated),
    "--tl-track-take": hexToRgba(hex, alpha.take),
    // AQU-2235: the waveform look (see WAVE_LOOK).
    "--tl-track-ground": hexToRgba(hex, WAVE_LOOK.ground),
    "--tl-track-played": hexToRgba(hex, WAVE_LOOK.played),
    "--tl-track-frame": hexToRgba(hex, WAVE_LOOK.frame),
    // Sam, Oct 28: the name bar takes the track's strip colour, matching the
    // strip at the track's far left, at 90% opacity (first chosen as the hue
    // at 34%).
    "--tl-track-bar": barColorFor(strip),
    "--tl-track-bar-ink": barInkFor(hex),
    "--tl-track-wave": waveColorFor(hex),
    "--tl-track-line": playLineColorCss(hex),
    "--tl-track-strip": strip,
  }
}

/**
 * THE WAVEFORM LOOK (AQU-2235; Sam, Oct 25, boards 51–53, and the name bar of
 * Oct 28, board 54). A take is a deeper shade of its track's hue on a light
 * wash of it, with a really faint frame instead of the old solid edge:
 *
 *   ground  12%   a recorded take AND a generated voice — "make the only
 *                 distinction between AI and non-AI the little star in the
 *                 corner", so the two strengths of the old ladder are one
 *   played  27%   the part of a playing take already heard
 *   frame   26%   1 px
 *
 * and the waveform itself is its track's colour 0.167 darker, chroma 0.14
 * (track-oklch; Oct 28 — it was oklch(0.55 0.14 <hue>) for every track) at
 * `wave`, dropping to `unplayed` on the part of a playing take not yet heard.
 * Like the ladder above, every value is an alpha over the theme's own ground,
 * so dark mode follows by itself.
 */
export const WAVE_LOOK = {
  ground: 0.12,
  played: 0.27,
  frame: 0.26,
  /** The waveform's opacity, at rest and on the part already played. */
  wave: 0.9,
  /** …and on the part of a playing take not yet played. */
  unplayed: 0.3,
  /** A muted track's clips, whole (Sam's board 51 suggestion). */
  muted: 0.5,
} as const

/**
 * A track's strip and dot: the waveform's chroma at the track's own lightness
 * (Sam, Oct 25: "the strip should match the waveform's saturation, not its
 * lightness"). For the six palette hues only — the derived rows' fixed
 * colours (the source text's grey, the source audio's aquilla blue) are
 * statements about what the row is, and stay exactly as they are.
 */
function stripColorFor(hex: string): string {
  return PALETTE_HEXES.has(hex) ? stripColorCss(hex) : hex
}

/**
 * A track's waveform: for the six palette hues, Sam's chroma 0.14; any other
 * colour (the source rows', a hex the briefly shipped picker wrote) is never
 * made MORE saturated than it is. A grey has no hue to raise, so lifting its
 * chroma painted it in whatever hue its rounding pointed at.
 */
function waveColorFor(hex: string): string {
  return waveColorCss(hex, PALETTE_HEXES.has(hex) ? WAVE_C : Math.min(WAVE_C, hexToOklch(hex).c))
}

/** The name bar: a strip colour at 90% opacity (Sam, Oct 28). */
export const NAME_BAR_OPACITY = 0.9
function barColorFor(strip: string): string {
  return `color-mix(in oklab, ${strip} ${Math.round(NAME_BAR_OPACITY * 100)}%, transparent)`
}

/**
 * The name bar's text on its strip colour. The palette's strips all sit at
 * oklch lightness 0.60–0.77, where dark ink reads at 4:1 or better and white
 * falls under 3.5:1, in either theme. Any other colour picks by its own
 * luminance.
 */
function barInkFor(hex: string): string {
  if (PALETTE_HEXES.has(hex)) return "#1c1f24"
  const m = /^#?([0-9a-f]{6})$/i.exec(hex)
  if (!m) return "#1c1f24"
  const n = parseInt(m[1], 16)
  const lin = (c: number) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }
  const lum = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255)
  return lum > 0.18 ? "#1c1f24" : "#ffffff"
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
//
// AQU-2235 (Sam, Oct 25): THAT EDGE IS NOW FAINT — the frame is the hue at 26%
// over a 12% ground — and a generated voice wears exactly what a recorded take
// does; only its sparkle marks it. See WAVE_LOOK.
/** An audio clip, recorded or generated alike (AQU-2235): the hue at 12% in a
 *  1 px frame at 26%. */
export const TRACK_CHIP_CLASS =
  "border-[color:var(--tl-track-frame)] bg-[color:var(--tl-track-ground)] text-foreground"
/** The waveform's fill: its track 0.167 darker (track-oklch). Opacity is the caller's
 *  (`WAVE_LOOK.wave`, or `unplayed` on the part not yet played). */
export const TRACK_WAVE_FILL_CLASS = "fill-[color:var(--tl-track-wave)]"
/** The name bar along a timeline clip's top (AQU-2235, board 54). */
export const TRACK_BAR_CLASS = "bg-[color:var(--tl-track-bar)] text-[color:var(--tl-track-bar-ink)]"
/** The gutter's 4px identity bar. A CLASS ON THE ROW'S ROOT, never a new
 *  element — see the note at its call site in TimelineEditor. AQU-2235: in the
 *  strip colour, the waveform's chroma at the track's own lightness. */
export const TRACK_ACCENT_CLASS = "border-l-4 border-l-[color:var(--tl-track-strip)]"
/** What anything on a coloured row does under the pointer. */
export const TRACK_HOVER_CLASS = "hover:bg-[color:var(--tl-track-hover)]"

/** …and the one for a chip that already has a fill to beat. See `hoverFill`:
 *  the two are the same CSS property, so the hover replaces the fill rather
 *  than layering over it, and the lighter rung made a hovered chip fainter. */
export const TRACK_HOVER_FILL_CLASS = "hover:bg-[color:var(--tl-track-hover-fill)]"
/** The gutter dot, in the strip colour (AQU-2235). */
export const TRACK_DOT_CLASS = "bg-[color:var(--tl-track-strip)]"
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

/**
 * THE SAME LADDER IN GREY, for a take drawn OFF the timeline (2026-09-25).
 *
 * Sam's ruling: the Recording tab, the Audio view card and the recorder draw a
 * take as the timeline's own chip, but not in its track's colour (that question
 * is parked). Setting these on a waveform rectangle makes the chip classes
 * above — body, outline, and the playing split — work unchanged on a neutral
 * body. Built from the theme's foreground and background so it follows dark
 * mode with no second set; the strengths mirror the hue ladder's spacing.
 */
export const NEUTRAL_TRACK_VARS: Record<string, string> = {
  "--tl-track-hue": "color-mix(in oklab, var(--foreground) 24%, var(--background))",
  "--tl-track-hover": "color-mix(in oklab, var(--foreground) 3.5%, var(--background))",
  "--tl-track-hover-fill": "color-mix(in oklab, var(--foreground) 12%, var(--background))",
  "--tl-track-gen": "color-mix(in oklab, var(--foreground) 5%, var(--background))",
  "--tl-track-take": "color-mix(in oklab, var(--foreground) 9%, var(--background))",
  // AQU-2235: the waveform look's grey, for a take with no track to colour it.
  "--tl-track-ground": "color-mix(in oklab, var(--foreground) 5%, var(--background))",
  "--tl-track-played": "color-mix(in oklab, var(--foreground) 11%, var(--background))",
  "--tl-track-frame": "color-mix(in oklab, var(--foreground) 12%, var(--background))",
  "--tl-track-bar": "color-mix(in oklab, color-mix(in oklab, var(--foreground) 24%, var(--background)) 90%, transparent)",
  "--tl-track-bar-ink": "var(--foreground)",
  "--tl-track-wave": "color-mix(in oklab, var(--foreground) 62%, var(--background))",
  "--tl-track-line": "color-mix(in oklab, var(--foreground) 80%, var(--background))",
  "--tl-track-strip": "color-mix(in oklab, var(--foreground) 24%, var(--background))",
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
//
// AQU-2235 (Sam, Oct 25): the played side moves one rung UP instead — ground
// 27% against the resting 12% — and the waveform does the rest of the work:
// full strength where it has played, 30% where it has not (the caller draws
// that split). One gradient for both kinds, as they now look the same.
/** The playing chip's fill — a progress split in the chip's own two rungs. */
export const TRACK_CHIP_PLAYING_CLASS =
  "bg-transparent bg-[image:linear-gradient(to_right,var(--tl-track-played)_var(--tl-play-x,0px),var(--tl-track-ground)_var(--tl-play-x,0px))]"

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
