// Test fixtures: real Bible Knowledge Pack data for MRK 1 (see
// ./ATTRIBUTION.md). Parsed with the pack client's own `parseLayer`.

import peopleJson from "./bkp-v1-MRK-1.people.json?raw"
import structureJson from "./bkp-v1-MRK-1.structure.json?raw"
import textJson from "./bkp-v1-MRK-1.text.json?raw"
import {
  parseLayer,
  type BkpPeopleLayer,
  type BkpStructureLayer,
  type BkpTextLayer,
} from "../pack-types"

export function mrk1People(): BkpPeopleLayer {
  const layer = parseLayer("people", "MRK", JSON.parse(peopleJson))
  if (!layer) throw new Error("bkp-v1-MRK-1.people.json is not a people layer for MRK")
  return layer
}

/** The words of MRK 1:29–31 only. */
export function mrk1Text(): BkpTextLayer {
  const layer = parseLayer("text", "MRK", JSON.parse(textJson))
  if (!layer) throw new Error("bkp-v1-MRK-1.text.json is not a text layer for MRK")
  return layer
}

/** MRK 1's pericopes, 1:1–8 to 1:40–45. */
export function mrk1Structure(): BkpStructureLayer {
  const layer = parseLayer("structure", "MRK", JSON.parse(structureJson))
  if (!layer) throw new Error("bkp-v1-MRK-1.structure.json is not a structure layer for MRK")
  return layer
}

/** ἦλθον in MRK 1:29, "they came": its implied subject is a group of five. */
export const ELTHON_1_29 = "n41001029007"
/** Jesus, Simon (Peter), Andrew, James and John, leaving the synagogue. */
export const JESUS_AND_FOUR = "grp:MRK:n41001021002"
export const PETER = "person:Peter"
export const MOTHER_IN_LAW = "local:MRK:n41001030003"
