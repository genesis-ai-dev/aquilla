// Shared fixtures for the AQU-1690 Bible data tests. Not a test file itself.
//
// JHN 4:7–10 from the real pack (trimmed): voices and structure from the
// AQU-1688 check fixtures, people and text from the facts fixtures, and
// (AQU-1701) the verses' Translation Questions from the notes layer (pack
// 1.2.0; unfoldingWord Translation Questions, CC BY-SA 4.0), unchanged.

import { JHN4_STRUCTURE, JHN4_VOICES } from "../../../../db/shared/bible-checks/__fixtures__/pack"
import {
  JHN_B_PEOPLE,
  JHN_B_SEGMENTS,
  JHN_B_STRUCTURE,
  JHN_B_TEXT_GLOSSED,
  JHN_B_VOICES,
} from "../../../../db/shared/bible-checks/__fixtures__/pack-b"
import { JHN4_PEOPLE, JHN4_TEXT } from "../../../../db/shared/bible-facts/__fixtures__/jhn4-people"
import type { LanguageProfile } from "../../../../db/shared/language-profile"
import type { BkpResult, BookPack } from "../bkp/pack-loader"
import type { BkpQuestion } from "../bkp/pack-types"
import type { CellPair } from "../agent/tools/select-cells"
import { prepareBibleRun, type BibleFlags, type BibleRunData } from "./bible-run"
import { pair } from "./test-helpers"

/** AQU-1701: the pack's Translation Questions on JHN 4:7–10 (its typo "suprised" included). */
export const JHN4_QUESTIONS: readonly BkpQuestion[] = [
  { id: "tq:172799", refs: ["JHN 4:7"], q: "Who came to Jacob’s well while Jesus was there?", a: "A Samaritan woman came there to draw water." },
  { id: "tq:172800", refs: ["JHN 4:7"], q: "What did Jesus first say to the Samaritan Woman?", a: "He said to her, “Give me some water to drink.”" },
  { id: "tq:172801", refs: ["JHN 4:8"], q: "Where were Jesus’ disciples?", a: "They had gone away into town to buy food." },
  { id: "tq:172802", refs: ["JHN 4:9"], q: "Why was the Samaritan woman suprised that Jesus would talk to her?", a: "She was surprised because Jews had no dealings with the Samaritans." },
  {
    id: "tq:172803",
    refs: ["JHN 4:10"],
    q: "What does Jesus say to turn the conversation to the things of God?",
    a: "Jesus tells her that if she had known the gift of God and who was talking to her, she would have asked, and he would have given her living water.",
  },
]

/** The fixture objects carry no literal types; the casts live here, once. */
export function jhn4Pack(over: Partial<BookPack> = {}): BookPack {
  return {
    version: "1.0.0",
    book: "JHN",
    voices: JHN4_VOICES as unknown as BookPack["voices"],
    structure: { ...JHN4_STRUCTURE, segments: [], moves: [] } as unknown as BookPack["structure"],
    people: JHN4_PEOPLE as unknown as BookPack["people"],
    text: JHN4_TEXT as unknown as BookPack["text"],
    questions: JHN4_QUESTIONS,
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

/**
 * AQU-1701: check pack B's John verses (1:40–43, 4:15–23, …) with their real
 * pericopes and verb glosses, for the participant questions. One cell per
 * verse, id "c" + the ref ("cJHN 1:42").
 */
export async function jhnBBibleData(refs: Record<string, string>, profile: LanguageProfile): Promise<BibleRunData> {
  const pack: BookPack = {
    version: "1.2.0",
    book: "JHN",
    voices: JHN_B_VOICES as unknown as BookPack["voices"],
    structure: { ...JHN_B_STRUCTURE, segments: JHN_B_SEGMENTS, moves: [] } as unknown as BookPack["structure"],
    people: JHN_B_PEOPLE as unknown as BookPack["people"],
    text: JHN_B_TEXT_GLOSSED as unknown as BookPack["text"],
    questions: null,
  }
  const run = await prepareBibleRun({
    pairs: Object.entries(refs).map(([ref, source]) => pair(`c${ref}`, { canonicalRef: ref, source })),
    profile,
    concepts: [],
    sourceLanguage: "en",
    flags: { autopilot: true, checks: true },
    loadPack: async () => ({ ok: true, value: pack }),
  })
  if (run.state !== "ready") throw new Error(`fixture Bible data not ready: ${run.state}`)
  return run.data
}

export async function jhn4BibleData(
  opts: { profile?: LanguageProfile; flags?: Partial<BibleFlags>; pairs?: CellPair[]; pack?: Partial<BookPack> } = {},
): Promise<BibleRunData> {
  const loadPack = async (): Promise<BkpResult<BookPack>> => ({ ok: true, value: jhn4Pack(opts.pack) })
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
