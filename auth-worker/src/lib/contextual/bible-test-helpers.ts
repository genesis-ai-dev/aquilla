// Shared fixtures for the AQU-1690 Bible data tests. Not a test file itself.
//
// JHN 4:7–10 from the real pack (trimmed): voices and structure from the
// AQU-1688 check fixtures, people and text from the facts fixtures.

import { JHN4_STRUCTURE, JHN4_VOICES } from "../../../../db/shared/bible-checks/__fixtures__/pack"
import { JHN4_PEOPLE, JHN4_TEXT } from "../../../../db/shared/bible-facts/__fixtures__/jhn4-people"
import type { LanguageProfile } from "../../../../db/shared/language-profile"
import type { BkpResult, BookPack } from "../bkp/pack-loader"
import type { CellPair } from "../agent/tools/select-cells"
import { prepareBibleRun, type BibleFlags, type BibleRunData } from "./bible-run"
import { pair } from "./test-helpers"

/** The fixture objects carry no literal types; the casts live here, once. */
export function jhn4Pack(over: Partial<BookPack> = {}): BookPack {
  return {
    version: "1.0.0",
    book: "JHN",
    voices: JHN4_VOICES as unknown as BookPack["voices"],
    structure: { ...JHN4_STRUCTURE, segments: [], moves: [] } as unknown as BookPack["structure"],
    people: JHN4_PEOPLE as unknown as BookPack["people"],
    text: JHN4_TEXT as unknown as BookPack["text"],
    ...over,
  }
}

/** English source for JHN 4:7–10, one cell per verse: c7…c10. */
export const JHN4_SOURCES: Record<string, string> = {
  "JHN 4:7": "A woman of Samaria came to draw water. Jesus said to her, “Give me a drink.”",
  "JHN 4:8": "For his disciples had gone away into the city to buy food.",
  "JHN 4:9":
    "The Samaritan woman said to him, “How is it that you, a Jew, ask for a drink from me, a woman of Samaria?” (For Jews have no dealings with Samaritans.)",
  "JHN 4:10":
    "Jesus answered her, “If you knew the gift of God, and who it is that is saying to you, ‘Give me a drink,’ you would have asked him, and he would have given you living water.”",
}

export function jhn4Pairs(over: Partial<CellPair> = {}): CellPair[] {
  return Object.entries(JHN4_SOURCES).map(([ref, source]) =>
    pair(`c${ref.split(":")[1]}`, { canonicalRef: ref, source, ...over }),
  )
}

/** English quotation marks: “ ” then ‘ ’. */
export const ENGLISH_QUOTES: LanguageProfile = {
  quoteMarks: {
    levels: [
      { open: "“", close: "”" },
      { open: "‘", close: "’" },
    ],
    continuation: "reopen-each-paragraph",
  },
  questionMarkers: {},
}

export async function jhn4BibleData(
  opts: { profile?: LanguageProfile; flags?: Partial<BibleFlags>; pairs?: CellPair[] } = {},
): Promise<BibleRunData> {
  const loadPack = async (): Promise<BkpResult<BookPack>> => ({ ok: true, value: jhn4Pack() })
  const run = await prepareBibleRun({
    pairs: opts.pairs ?? jhn4Pairs(),
    profile: opts.profile ?? ENGLISH_QUOTES,
    concepts: [],
    flags: { autopilot: true, checks: true, ...opts.flags },
    loadPack,
  })
  if (run.state !== "ready") throw new Error(`fixture Bible data not ready: ${run.state}`)
  return run.data
}
