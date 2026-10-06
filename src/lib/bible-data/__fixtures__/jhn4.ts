// Test fixtures: real Bible Knowledge Pack data for JHN 4 (see
// ./ATTRIBUTION.md). Parsed with the pack client's own `parseLayer`, so a
// fixture the client would reject fails here first.

import peopleJson from "./bkp-v1-JHN-4.people.json?raw"
import structureJson from "./bkp-v1-JHN-4.structure.json?raw"
import textJson from "./bkp-v1-JHN-4.text.json?raw"
import voicesJson from "./bkp-v1-JHN-4.voices.json?raw"
import {
  parseLayer,
  type BkpPeopleLayer,
  type BkpStructureLayer,
  type BkpTextLayer,
  type BkpVoicesLayer,
} from "../pack-types"

/** The raw files, for tests that serve them over a stubbed fetch. */
export const JHN4_VOICES_JSON: string = voicesJson
export const JHN4_PEOPLE_JSON: string = peopleJson
export const JHN4_TEXT_JSON: string = textJson
export const JHN4_STRUCTURE_JSON: string = structureJson

export function jhn4Voices(): BkpVoicesLayer {
  const layer = parseLayer("voices", "JHN", JSON.parse(voicesJson))
  if (!layer) throw new Error("bkp-v1-JHN-4.voices.json is not a voices layer for JHN")
  return layer
}

export function jhn4People(): BkpPeopleLayer {
  const layer = parseLayer("people", "JHN", JSON.parse(peopleJson))
  if (!layer) throw new Error("bkp-v1-JHN-4.people.json is not a people layer for JHN")
  return layer
}

/** The words of JHN 4:6–10 and 4:27 only. */
export function jhn4Text(): BkpTextLayer {
  const layer = parseLayer("text", "JHN", JSON.parse(textJson))
  if (!layer) throw new Error("bkp-v1-JHN-4.text.json is not a text layer for JHN")
  return layer
}

/** JHN 4's three pericopes: 4:1–26, 4:27–42 and 4:43–54. */
export function jhn4Structure(): BkpStructureLayer {
  const layer = parseLayer("structure", "JHN", JSON.parse(structureJson))
  if (!layer) throw new Error("bkp-v1-JHN-4.structure.json is not a structure layer for JHN")
  return layer
}

/**
 * A verse as a Macula import stores it (src/lib/parsers/macula.ts): the
 * Macula words joined by single spaces, without the punctuation that Macula
 * keeps in `after`.
 */
export function maculaImportText(text: BkpTextLayer, ref: string): string {
  return text.verses[ref].map((id) => text.words[id].text).join(" ")
}

export const JESUS = "person:Jesus.2"
/** "Samaritan woman": an unnamed participant, labelled from the FCBH character id. */
export const SAMARITAN_WOMAN = "local:JHN:n43004007002"
/** The disciples in 4:27–42 (the pack merges unnamed participants per pericope). */
export const DISCIPLES = "local:JHN:n43004027006"
/** The disciples in 4:1–26: μαθηταί in 4:8 anchors their own entity there. */
export const DISCIPLES_4_8 = "local:JHN:n43004008003"
/** αὐτόν in JHN 4:10: Jesus, reached through λέγων in two hops. */
export const AUTON_4_10 = "n43004010024"
