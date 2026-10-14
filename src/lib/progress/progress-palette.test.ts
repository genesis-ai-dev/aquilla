import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import {
  audioProgressSegments,
  PROGRESS_BG,
  PROGRESS_COLOR,
  textProgressSegments,
  type ProgressSegment,
} from "./progress-palette"

/** Segments as "tone pct" pairs, so a table row reads like the bar. */
const drawn = (segments: ProgressSegment[]) => segments.map((s) => `${s.tone} ${s.pct}`)

describe("progress segments (AQU-1764)", () => {
  it.each<[string, ProgressSegment[], string[]]>([
    [
      "text: validated, then translated-not-validated, then AI drafts",
      textProgressSegments({ validated: 64, translated: 82, aiDrafted: 9, total: 100 }),
      ["textValidated 64", "textTranslated 9", "textAi 9"],
    ],
    [
      "text from counts, without an AI count",
      textProgressSegments({ validated: 5, translated: 8, total: 10 }),
      ["textValidated 50", "textTranslated 30"],
    ],
    [
      "text with nothing validated drops the validated part",
      textProgressSegments({ validated: 0, translated: 40, aiDrafted: 0, total: 100 }),
      ["textTranslated 40"],
    ],
    [
      "text fully validated is one part",
      textProgressSegments({ validated: 100, translated: 100, aiDrafted: 0, total: 100 }),
      ["textValidated 100"],
    ],
    [
      "text: AI drafts covering everything not validated leave no plain translated part",
      textProgressSegments({ validated: 20, translated: 50, aiDrafted: 30, total: 100 }),
      ["textValidated 20", "textAi 30"],
    ],
    [
      "text clamps validated into translated and AI into what is left",
      textProgressSegments({ validated: 90, translated: 60, aiDrafted: 15, total: 100 }),
      ["textValidated 60"],
    ],
    [
      "text with no cells draws nothing",
      textProgressSegments({ validated: 0, translated: 0, total: 0 }),
      [],
    ],
    [
      "audio: validated, then recorded-not-validated",
      audioProgressSegments({ validated: 27, recorded: 36, total: 100 }),
      ["audioValidated 27", "audioRecorded 9"],
    ],
    [
      "audio clamps a count past its total (audio left on a tombstoned file)",
      audioProgressSegments({ validated: 3, recorded: 140, total: 100 }),
      ["audioValidated 3", "audioRecorded 97"],
    ],
    [
      "audio with nothing recorded draws nothing",
      audioProgressSegments({ validated: 0, recorded: 0, total: 100 }),
      [],
    ],
  ])("%s", (_name, segments, expected) => {
    expect(drawn(segments)).toEqual(expected)
  })
})

// happy-dom resolves no custom properties and paints nothing, so a token
// missing from one theme would only show as the wrong colour in a browser.
// The stylesheet is plain text; read it (the bare relative path is the one
// that works here — see the same check in track-colors.test.ts).
describe("the progress tokens exist in both themes (AQU-1764)", () => {
  const css = readFileSync("src/index.css", "utf8")
  /** A block's text, from the selector that opens it to the brace that closes it. */
  const block = (selector: string, close: string) => {
    const at = css.indexOf(selector)
    expect(at, `${selector} not found`).toBeGreaterThan(-1)
    return css.slice(at, css.indexOf(close, at))
  }
  const light = block(":where(:root)", "\n  }")
  const dark = block(":where(html.dark)", "\n  }")
  const theme = block("@theme inline", "\n}")

  it("defines every palette colour in light and dark, maps it for Tailwind, and draws the stripes from it", () => {
    const tokens = [
      ...Object.values(PROGRESS_COLOR).map((v) => v.slice("var(--".length, -1)),
      "progress-ai-stripe",
    ]
    for (const token of tokens) {
      expect(light, token).toMatch(new RegExp(`--${token}:\\s*oklch\\(`))
      expect(dark, token).toMatch(new RegExp(`--${token}:\\s*oklch\\(`))
      expect(theme, token).toContain(`--color-${token}: var(--${token});`)
    }
    // Every solid fill class names a mapped colour; the AI fill is the utility.
    for (const cls of Object.values(PROGRESS_BG).filter((c) => c !== PROGRESS_BG.textAi)) {
      expect(theme).toContain(`--color-${cls.slice("bg-".length)}:`)
    }
    const stripes = css.slice(css.indexOf(`@utility ${PROGRESS_BG.textAi}`))
    expect(stripes).toMatch(/var\(--progress-text-translated\) 0 3px,\s*var\(--progress-ai-stripe\) 3px 6px/)
  })
})
