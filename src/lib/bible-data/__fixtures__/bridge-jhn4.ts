// Test fixture: JHN 4 for the Bridge 1 aligner (AQU-1694). See ./ATTRIBUTION.md.
//
// Per verse: the pack's Greek words (only the fields the aligner reads), the
// BSB text as a project's source cell would hold it, and, per Greek word, the
// BSB tokens Clear's manual SBLGNT→BSB alignment links it to (indexes in
// `tokenize(bsb)` order). Written by `pnpm bridges:eval … --write-fixture`.

import fixtureJson from "./bridge-jhn4.json?raw"
import type { BkpTextLayer } from "../pack-types"

export interface BridgeFixtureWord {
  id: string
  text: string
  lemma: string
  class: string
  type: string | null
  /** Clear's manual links, as BSB token indexes. */
  gold: number[]
}

export interface BridgeFixtureVerse {
  ref: string
  bsb: string
  words: BridgeFixtureWord[]
}

export function bridgeJhn4(): BridgeFixtureVerse[] {
  return (JSON.parse(fixtureJson) as { verses: BridgeFixtureVerse[] }).verses
}

/** The fixture's Greek as a pack text layer (fields the aligner does not read are blank). */
export function bridgeJhn4Text(verses: readonly BridgeFixtureVerse[] = bridgeJhn4()): BkpTextLayer {
  const layer: BkpTextLayer = { book: "JHN", verses: {}, words: {} }
  for (const verse of verses) {
    layer.verses[verse.ref] = verse.words.map((word) => word.id)
    for (const word of verse.words) {
      layer.words[word.id] = {
        text: word.text,
        after: " ",
        lemma: word.lemma,
        gloss: "",
        class: word.class,
        ...(word.type ? { type: word.type } : {}),
        morph: "",
      }
    }
  }
  return layer
}
