// AQU-646 stage 7: one hue, three alphas.

import { describe, expect, it } from "vitest"

import {
  ALPHA,
  DEFAULT_HUE,
  TRACK_ACCENT_CLASS,
  TRACK_CHIP_GENERATED_CLASS,
  TRACK_CHIP_TAKE_CLASS,
  TRACK_DASH_CLASS,
  TRACK_DOT_CLASS,
  TRACK_HOVER_CLASS,
  TRACK_HUES,
  TRACK_LANE_TINT_CLASS,
  hexToRgba,
  isColorableKind,
  hueForTrack,
  parseTrackHue,
  trackChipClass,
  trackChipPlayingClass,
  trackHueVars,
  trackHueVarsFor,
} from "./track-colors"

const hue = (id: string) => TRACK_HUES.find((h) => h.id === id)!

describe("the palette", () => {
  // Sam's own seven, from the spec he wrote (2026-08-27), evenly spaced in
  // OKLCH. Pinned by value because the point of the exercise was choosing them.
  it("is Sam's six hues, in his order", () => {
    expect(TRACK_HUES.map((h) => h.id)).toEqual([
      "cyan", "azure", "violet", "magenta", "amber", "green",
    ])
    // Coral is gone and two were retuned by eye (Sam, 2026-08-27): magenta
    // toward red with more saturation, amber brightened to 92% HSB.
    expect(TRACK_HUES.map((h) => h.hex)).toEqual([
      "#00c3cd", "#2489eb", "#865deb", "#da2b84", "#eba720", "#40c06e",
    ])
  })

  it("gives every hue an id, a hex and a name to translate", () => {
    for (const h of TRACK_HUES) {
      expect(h.hex, h.id).toMatch(/^#[0-9a-f]{6}$/)
      expect(h.labelKey, h.id).toMatch(/^editor\.timeline\.color/)
    }
    expect(new Set(TRACK_HUES.map((h) => h.id)).size).toBe(TRACK_HUES.length)
  })

  it("defaults to green, the nearest thing here to the shipped emerald", () => {
    expect(DEFAULT_HUE.id).toBe("green")
  })

  // Sam moved the whole ladder down a rung after using it: the lane lost its
  // colour, the lane's value went to generated voices and the generated value
  // to recorded takes. The two chip values are an even ladder —
  // a third and two thirds of the way to the solid.
  it("keeps an even ladder of alphas, with the lane painting nothing", () => {
    expect(ALPHA).toEqual({ hover: 0.18, generated: 0.33, take: 0.67 })
    expect(TRACK_LANE_TINT_CLASS).toBe("")
  })
})

describe("reading a stored value", () => {
  it("takes a preset id", () => {
    expect(parseTrackHue("cyan")).toBe("#00c3cd")
    expect(parseTrackHue("amber")).toBe("#eba720")
  })

  it("takes a bare hex, which is what the picker writes", () => {
    expect(parseTrackHue("00c3cd")).toBe("#00c3cd")
    expect(parseTrackHue("123456")).toBe("#123456")
  })

  // THE MIGRATION THAT ISN'T. Every value already on disk is a two-part pair
  // from the old two-axis palette; this model has no second axis, so the first
  // half wins and the second is dropped.
  it("takes the first half of a legacy pair and drops the second", () => {
    expect(parseTrackHue("green-teal")).toBe(hue("green").hex)
    expect(parseTrackHue("violet-magenta")).toBe(hue("violet").hex)
    expect(parseTrackHue("00c3cd-8b5cf6")).toBe("#00c3cd")
  })

  it("falls back for a retired id rather than failing", () => {
    // teal, indigo, fuchsia and slate were hues in earlier palettes and are not
    // here. A pattern-not-enum wire format is exactly what makes that safe.
    for (const retired of ["teal", "indigo", "fuchsia", "slate", "emerald", "nonsense", ""]) {
      expect(parseTrackHue(retired), retired).toBe(DEFAULT_HUE.hex)
    }
    expect(parseTrackHue(null)).toBe(DEFAULT_HUE.hex)
    expect(parseTrackHue(undefined)).toBe(DEFAULT_HUE.hex)
  })

  // What the menu writes has to survive the server, which validates a colour as
  // a pattern rather than an enum.
  it("round-trips every preset id through the server's pattern", () => {
    const pattern = /^[a-z0-9][a-z0-9-]{0,31}$/
    for (const h of TRACK_HUES) {
      expect(pattern.test(h.id), h.id).toBe(true)
      expect(parseTrackHue(h.id)).toBe(h.hex)
    }
  })
})

describe("the alphas", () => {
  it("turns a hex into rgba at the asked-for alpha", () => {
    expect(hexToRgba("#00c3cd", ALPHA.take)).toBe("rgba(0, 195, 205, 0.67)")
    expect(hexToRgba("#00c3cd", ALPHA.generated)).toBe("rgba(0, 195, 205, 0.33)")
    expect(hexToRgba("#ffffff", 1)).toBe("rgba(255, 255, 255, 1)")
  })

  it("never emits NaN into a style, whatever it is handed", () => {
    expect(hexToRgba("nope", 0.5)).toBe("rgba(0, 0, 0, 0.5)")
  })

  // The variables are the whole interface between this module and the lane.
  it("publishes the hue and its three variants as custom properties", () => {
    expect(trackHueVars("cyan")).toEqual({
      "--tl-track-hue": "#00c3cd",
      "--tl-track-hover": "rgba(0, 195, 205, 0.18)",
      "--tl-track-gen": "rgba(0, 195, 205, 0.33)",
      "--tl-track-take": "rgba(0, 195, 205, 0.67)",
    })
  })

  it("publishes the default for a track that has never been coloured", () => {
    expect(trackHueVars(null)["--tl-track-hue"]).toBe(DEFAULT_HUE.hex)
  })
})

describe("the class vocabulary", () => {
  // EVERY ONE MUST BE A LITERAL. Tailwind emits only what it can see while
  // scanning source, so a constructed class produces no CSS at all — silently,
  // and looking exactly like a data problem.
  it("holds no template interpolation anywhere", () => {
    const all = [
      TRACK_CHIP_TAKE_CLASS, TRACK_CHIP_GENERATED_CLASS,
      TRACK_ACCENT_CLASS, TRACK_DOT_CLASS,
    ]
    for (const cls of all) {
      expect(cls, cls).not.toContain("${")
      expect(cls, cls).toMatch(/var\(--tl-track-|text-foreground|border-l-4/)
    }
  })

  // Sam, 2026-08-27: "put full fill color as outline of chips." An audio chip
  // gets a definite edge rather than a soft block that dissolves into the row —
  // and it is the same solid the gutter accent and the dot already use.
  it("outlines both audio chips in the hue at full strength", () => {
    for (const cls of [TRACK_CHIP_TAKE_CLASS, TRACK_CHIP_GENERATED_CLASS]) {
      expect(cls).toContain("border-[color:var(--tl-track-hue)]")
      // …while the FILL stays the wash that says which kind of clip it is.
      expect(cls).not.toContain("bg-[color:var(--tl-track-hue)]")
    }
  })

  it("picks the body for a take and the lighter wash for a generated voice", () => {
    expect(trackChipClass("take")).toBe(TRACK_CHIP_TAKE_CLASS)
    expect(trackChipClass("generated")).toBe(TRACK_CHIP_GENERATED_CLASS)
    expect(trackChipClass("take")).toContain("--tl-track-take")
    expect(trackChipClass("generated")).toContain("--tl-track-gen")
  })

  // Both chips are washes now — most of what you read against is the page — so
  // the theme's own foreground is right in both themes, and ink chosen against
  // the hue would be wrong.
  it("inks both chips against the theme, not against the hue", () => {
    for (const cls of [TRACK_CHIP_TAKE_CLASS, TRACK_CHIP_GENERATED_CLASS]) {
      expect(cls).toContain("text-foreground")
      expect(cls).not.toContain("--tl-track-ink")
    }
  })

  // THE INVARIANT THE WHOLE SCHEME RESTS ON: the identity classes may only set
  // groups the state layers also set, so a warning can override them. A `ring-`
  // or an `opacity-` here would be a tint the alarm vocabulary cannot beat.
  it("introduces no utility group the state layers cannot override", () => {
    for (const cls of [TRACK_CHIP_TAKE_CLASS, TRACK_CHIP_GENERATED_CLASS]) {
      expect(cls).not.toMatch(/(^|\s)ring-/)
      expect(cls).not.toMatch(/(^|\s)opacity-/)
      expect(cls).not.toMatch(/(^|\s)border-[lrtbxy]-/)
      expect(cls).not.toMatch(/(^|\s)shadow-/)
    }
  })
})

// AQU-646 stage 7: the derived rows went through the same vocabulary, so the
// gutter and the lanes are drawn from one system rather than two.
describe("the rows nobody picks a colour for", () => {
  it("gives each derived kind a hue of its own", () => {
    expect(hueForTrack("source-subtitles", null)).toBe("#8b93a3")
    expect(hueForTrack("source-audio", null)).toBe("#0e9bd6")
    expect(hueForTrack("target-subtitles", null)).toBe("#40c06e")
  })

  // Their colours are statements about what the row IS, so a stored value —
  // which nothing should ever write for these — must not move them.
  it("ignores a colour written onto one anyway", () => {
    expect(hueForTrack("source-audio", "magenta")).toBe("#0e9bd6")
    expect(hueForTrack("source-subtitles", "da2b84")).toBe("#8b93a3")
  })

  it("keeps a pickable row's own colour, and its default", () => {
    expect(hueForTrack("target-audio", "magenta")).toBe("#da2b84")
    expect(hueForTrack("audio", "cyan")).toBe("#00c3cd")
    expect(hueForTrack("target-audio", null)).toBe(DEFAULT_HUE.hex)
  })

  // Source audio's blue and the palette's Azure have to stay tellable apart —
  // a track wearing Azure must not read as the source-audio row.
  it("keeps source audio clear of the palette's azure", () => {
    expect(hueForTrack("source-audio", null)).not.toBe(hue("azure").hex)
  })

  it("publishes their hues through the same variables as everything else", () => {
    const vars = trackHueVarsFor("target-subtitles", null)
    expect(vars["--tl-track-hue"]).toBe("#40c06e")
    expect(vars["--tl-track-hover"]).toBe("rgba(64, 192, 110, 0.18)")
    expect(vars["--tl-track-gen"]).toBe("rgba(64, 192, 110, 0.33)")
  })
})

// Sam, 2026-08-27: "when hovering any source audio chip region, real or
// dotted, have the hover color be 18% opacity." Both surfaces answer the
// pointer in the row's own hue at the lightest rung.
// Sam, 2026-08-27: source audio drops to 24% fill and 12% hover. It is the one
// row you are not working ON — reference material, hundreds of chips, often
// continuous for minutes — so at the shared strength it reads as a solid band
// and competes with the dub row underneath it.
describe("source audio, drawn lighter than everything else", () => {
  it("takes its own fill and hover, below the shared ladder", () => {
    const vars = trackHueVarsFor("source-audio", null)
    expect(vars["--tl-track-gen"]).toBe("rgba(14, 155, 214, 0.24)")
    expect(vars["--tl-track-hover"]).toBe("rgba(14, 155, 214, 0.12)")
  })

  it("leaves every other row on the shared ladder", () => {
    for (const kind of ["target-audio", "audio", "source-subtitles", "target-subtitles"]) {
      const vars = trackHueVarsFor(kind, null)
      const hue = vars["--tl-track-hue"]
      expect(vars["--tl-track-gen"], kind).toBe(hexToRgba(hue, ALPHA.generated))
      expect(vars["--tl-track-hover"], kind).toBe(hexToRgba(hue, ALPHA.hover))
    }
  })

  // Still a ladder, just a shorter one — the hover must stay under the fill or
  // pointing at a chip would darken it past what it means.
  it("keeps its two rungs in order", () => {
    const vars = trackHueVarsFor("source-audio", null)
    expect(vars["--tl-track-hover"]).toBe(hexToRgba("#0e9bd6", 0.12))
    expect(0.12).toBeLessThan(0.24)
  })
})

describe("what answers the pointer", () => {
  it("uses the hover wash, and it is the lightest rung", () => {
    expect(TRACK_HOVER_CLASS).toBe("hover:bg-[color:var(--tl-track-hover)]")
    expect(ALPHA.hover).toBeLessThan(ALPHA.generated)
  })

  it("gives the dotted placeholder the same hover, over no fill at rest", () => {
    expect(TRACK_DASH_CLASS).toContain("hover:bg-[color:var(--tl-track-hover)]")
    // Nothing at rest: a block of colour would overstate an absence.
    expect(TRACK_DASH_CLASS).not.toMatch(/(^|\s)bg-/)
    expect(TRACK_DASH_CLASS).toContain("border-dashed")
  })
})

describe("which rows may be recoloured", () => {
  it("is the audio rows, derived and added alike", () => {
    expect(isColorableKind("target-audio")).toBe(true)
    expect(isColorableKind("audio")).toBe(true)
  })

  it("is never a source row or a folder", () => {
    for (const kind of ["source-subtitles", "source-audio", "target-subtitles", "folder"]) {
      expect(isColorableKind(kind), kind).toBe(false)
    }
  })
})

describe("the preview progress fill (2026-08-27)", () => {
  it("splits each kind's fill at the playhead, in the ladder's own rungs", () => {
    const take = trackChipPlayingClass("take")
    expect(take).toContain("var(--tl-track-take)_var(--tl-play-x")
    expect(take).toContain("var(--tl-track-hover)_var(--tl-play-x")
    const gen = trackChipPlayingClass("generated")
    expect(gen).toContain("var(--tl-track-gen)_var(--tl-play-x")
    expect(gen).toContain("var(--tl-track-hover)_var(--tl-play-x")
  })

  it("mutes the identity colour underneath — the gradient's washes must not stack on it", () => {
    expect(trackChipPlayingClass("take")).toContain("bg-transparent")
    expect(trackChipPlayingClass("generated")).toContain("bg-transparent")
  })
})
