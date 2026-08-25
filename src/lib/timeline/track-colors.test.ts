// AQU-646 — the track colour palette. Six hues, two weights, two axes.
//
// Three of these tests are worth more than the rest, and none is about a colour
// looking right:
//
//   · "an untouched track is byte-identical" is what stops a palette round
//     silently repainting every project in the app. It is also what makes the
//     "Default" item unnecessary, so it is load-bearing twice.
//   · "no hue reaches into the state layers' vocabulary" is what stops someone
//     adding an amber, which would make a take running long indistinguishable
//     from a take at rest. That failure is invisible in review — the swatch
//     looks lovely — and only shows up when something goes wrong on someone
//     else's project.
//   · "every class is a literal" is what stops someone tidying the table into a
//     template. Tailwind generates only the classes it can see in source, so a
//     constructed one produces no CSS and the chip renders untinted.

import { describe, expect, it } from "vitest"
import {
  DEFAULT_PRIMARY,
  DEFAULT_SECONDARY,
  TRACK_HUES,
  formatTrackColor,
  isColorableKind,
  parseTrackColor,
  trackChipTint,
  trackDot,
} from "./track-colors"

const hue = (id: string) => TRACK_HUES.find((h) => h.id === id)!

describe("the palette's shape", () => {
  it("offers six hues, none of them duplicated", () => {
    const ids = TRACK_HUES.map((h) => h.id)
    expect(ids).toEqual(["green", "teal", "indigo", "violet", "fuchsia", "slate"])
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("gives every hue both weights, a dot and an i18n key", () => {
    for (const h of TRACK_HUES) {
      expect(h.light, h.id).toMatch(/^border-/)
      expect(h.dark, h.id).toMatch(/^border-/)
      expect(h.swatchLight, h.id).toMatch(/^bg-/)
      expect(h.swatchDark, h.id).toMatch(/^bg-/)
      expect(h.labelKey, h.id).toMatch(/^editor\.timeline\.color/)
    }
  })

  // The ids are persisted into files.meta and validated by the worker's
  // TRACK_COLOR_PATTERN. An id this side would happily write and that side
  // would 400 makes every retry of that event fail identically, which wedges
  // the client's outbox behind it.
  //
  // THE PAIRED FORM HAS TO PASS IT TOO — that is why this design needed no
  // worker change at all.
  it("produces values the server's pattern accepts, in every combination", () => {
    const pattern = /^[a-z0-9][a-z0-9-]{0,31}$/
    for (const a of TRACK_HUES) {
      expect(a.id, a.id).toMatch(pattern)
      for (const b of TRACK_HUES) {
        expect(formatTrackColor(a.id, b.id), `${a.id}-${b.id}`).toMatch(pattern)
      }
    }
  })
})

describe("an untouched track", () => {
  // Sam, 2026-08-22: "our green purple pairing for the default first track
  // should remain as is until manually changed." These two strings are copied
  // byte-for-byte from the tint that shipped. If they drift, every project in
  // the app silently gets a new look — which is why the literals are written
  // out here rather than referenced from the module under test.
  it("keeps the shipped emerald/violet EXACTLY", () => {
    for (const none of [null, undefined, ""]) {
      expect(trackChipTint(none, "take")).toBe(
        "border-emerald-500/60 bg-emerald-100/80 text-emerald-800 dark:bg-emerald-950/70 dark:text-emerald-300",
      )
      expect(trackChipTint(none, "generated")).toBe(
        "border-violet-500/60 bg-violet-100/80 text-violet-800 dark:bg-violet-950/70 dark:text-violet-300",
      )
      expect(trackDot(none)).toBe("bg-emerald-600")
    }
  })

  // THE REASON THERE IS NO "DEFAULT" ITEM IN THE PICKER (Sam, 2026-08-25).
  // The shipped look has to be reachable by picking two ordinary swatches,
  // otherwise removing that item would strand it.
  it("is reachable by picking green and violet like anything else", () => {
    const explicit = formatTrackColor("green", "violet")
    expect(trackChipTint(explicit, "take")).toBe(trackChipTint(null, "take"))
    expect(trackChipTint(explicit, "generated")).toBe(trackChipTint(null, "generated"))
    expect(trackDot(explicit)).toBe(trackDot(null))
  })

  // …and it shows its ticks there, so an untouched track does not read as
  // having no colour at all.
  it("reports green and violet as its current choice", () => {
    expect(parseTrackColor(null).primary.id).toBe("green")
    expect(parseTrackColor(null).secondary.id).toBe("violet")
    expect(DEFAULT_PRIMARY.id).toBe("green")
    expect(DEFAULT_SECONDARY.id).toBe("violet")
  })
})

describe("the hues the state layers have already claimed", () => {
  // amber-500 = soft overflow, red-500 = at fault, sky-500 = selection ring AND
  // the Source-audio dot. A track wearing any of them is a track whose warnings
  // cannot be seen. rose/pink sit in the same register as the at-fault body.
  const RESERVED = ["amber", "red", "rose", "pink", "orange", "sky", "yellow"]

  it("no hue reaches into any of them", () => {
    for (const h of TRACK_HUES) {
      for (const reserved of RESERVED) {
        const used = `${h.light} ${h.dark} ${h.swatchLight} ${h.swatchDark}`
        expect(used.includes(`-${reserved}-`), `${h.id} uses ${reserved}`).toBe(false)
      }
    }
  })
})

describe("every class is a literal, because Tailwind only emits what it can see", () => {
  it("has no template interpolation anywhere in the table", () => {
    for (const h of TRACK_HUES) {
      for (const cls of [h.light, h.dark, h.swatchLight, h.swatchDark]) {
        expect(cls, h.id).not.toContain("${")
      }
    }
  })

  // A missing dark: variant is not a small omission — it means the chip keeps
  // its light-mode fill in dark mode and the text on it becomes unreadable.
  it("gives both weights of both hues a full light+dark recipe", () => {
    for (const h of TRACK_HUES) {
      for (const [name, cls] of [["light", h.light], ["dark", h.dark]] as const) {
        expect(cls, `${h.id}.${name}`).toMatch(/^border-\w+-\d+(\/\d+)? /)
        expect(cls, `${h.id}.${name}`).toMatch(/ bg-\w+-\d+(\/\d+)? /)
        expect(cls, `${h.id}.${name}`).toMatch(/ text-\w+-\d+/)
        expect(cls, `${h.id}.${name}`).toMatch(/ dark:bg-\w+-\d+(\/\d+)?/)
        expect(cls, `${h.id}.${name}`).toMatch(/ dark:text-\w+-\d+$/)
      }
    }
  })

  // SAM'S ACTUAL REQUIREMENT, and the reason a same-hue pair is legal at all:
  // every primary is drawn lighter than every secondary. Hue cannot tell the
  // two roles apart when both are green, so weight must — and it has to hold
  // for EVERY hue, not just the one anybody happened to look at.
  it("draws every hue's primary weight lighter than its secondary weight", () => {
    for (const h of TRACK_HUES) {
      const lightFill = Number(h.light.match(/bg-\w+-(\d+)/)![1])
      const darkFill = Number(h.dark.match(/bg-\w+-(\d+)/)![1])
      expect(lightFill, `${h.id} light fill`).toBeLessThan(darkFill)
    }
  })

  // The state layers come AFTER the palette in the chip's class list, and
  // tailwind-merge resolves last-wins PER UTILITY GROUP. A palette entry that
  // introduced a group the warning layers do not also set — a ring, a
  // border-side, an opacity — would survive past them and beat the warning.
  it("introduces no utility group the state layers cannot override", () => {
    for (const h of TRACK_HUES) {
      for (const cls of [h.light, h.dark]) {
        expect(cls, h.id).not.toMatch(/\bring-/)
        expect(cls, h.id).not.toMatch(/\bborder-[lrtbxy]-/)
        expect(cls, h.id).not.toMatch(/\bopacity-/)
      }
    }
  })
})

describe("reading and writing a two-axis colour", () => {
  it("round-trips a pair", () => {
    const value = formatTrackColor("violet", "green")
    expect(value).toBe("violet-green")
    expect(parseTrackColor(value).primary.id).toBe("violet")
    expect(parseTrackColor(value).secondary.id).toBe("green")
  })

  // The point of two weights: hue stops carrying the distinction, so the same
  // hue on both axes is a legal and useful choice.
  it("allows the same hue twice and still draws two tones", () => {
    for (const h of TRACK_HUES) {
      const value = formatTrackColor(h.id, h.id)
      expect(trackChipTint(value, "take")).toBe(h.light)
      expect(trackChipTint(value, "generated")).toBe(h.dark)
      expect(trackChipTint(value, "take")).not.toBe(trackChipTint(value, "generated"))
    }
  })

  it("reads a bare id as that hue on both axes", () => {
    expect(parseTrackColor("violet").primary.id).toBe("violet")
    expect(parseTrackColor("violet").secondary.id).toBe("violet")
  })

  // THIS IS WHY THE SERVER VALIDATES A PATTERN AND NOT AN ENUM. A newer client
  // ships palette entries this build has never heard of, and during a rollout
  // the newer client is the normal case. Falling back means the track is still
  // there, still named and still playing — just not in the colour someone else
  // picked — and its stored value is untouched, so their client keeps showing
  // it correctly. The two retired palettes' ids land here too.
  it("falls back for hues it cannot name, including the retired palettes'", () => {
    for (const retired of ["lime", "emerald", "purple", "stone", "cyan"]) {
      expect(trackChipTint(retired, "take"), retired).toBe(hue("green").light)
    }
    // A whole pair from a retired palette falls all the way back to the default.
    expect(trackChipTint("lime-stone", "take")).toBe(hue("green").light)
    expect(trackChipTint("lime-stone", "generated")).toBe(hue("violet").dark)
    // …and a half-known value still draws the half it knows.
    expect(trackChipTint("teal-stone", "take")).toBe(hue("teal").light)
    expect(trackChipTint("teal-stone", "generated")).toBe(hue("violet").dark)
  })

  it("picks the weight by clip kind", () => {
    expect(trackChipTint("green-green", "take")).toBe(hue("green").light)
    expect(trackChipTint("green-green", "generated")).toBe(hue("green").dark)
  })

  it("takes the gutter dot from the primary", () => {
    expect(trackDot("violet-green")).toBe(hue("violet").swatchDark)
  })
})

describe("which kinds may be recoloured at all", () => {
  // Sam confirmed the derived dub row on 2026-08-24 — it is a dub row like any
  // other, and it has always been included here.
  it("allows the derived dub row and added audio tracks", () => {
    expect(isColorableKind("target-audio")).toBe(true)
    expect(isColorableKind("audio")).toBe(true)
  })

  // Sam, 2026-08-22: "do not be changeable. It is deliberate, we've talked
  // about this many times." Grey for source subtitles and aquilla blue for
  // source audio are statements, not unassigned defaults.
  it("refuses the source rows and folders", () => {
    expect(isColorableKind("source-subtitles")).toBe(false)
    expect(isColorableKind("source-audio")).toBe(false)
    expect(isColorableKind("target-subtitles")).toBe(false)
    expect(isColorableKind("folder")).toBe(false)
  })
})
