// Test fixtures: real Bible Knowledge Pack data for JHN 4:1–15 and 4:34–38
// (see ./ATTRIBUTION.md). Parsed with the pack client's own `parseLayer`, so
// a fixture the client would reject fails here first.

import peopleJson from "./bkp-v1-JHN-4.people.json?raw"
import voicesJson from "./bkp-v1-JHN-4.voices.json?raw"
import { parseLayer, type BkpPeopleLayer, type BkpVoicesLayer } from "../pack-types"

/** The raw files, for tests that serve them over a stubbed fetch. */
export const JHN4_VOICES_JSON: string = voicesJson
export const JHN4_PEOPLE_JSON: string = peopleJson

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

export const JESUS = "person:Jesus.2"
/** "Samaritan woman": an unnamed participant, labelled from the FCBH character id. */
export const SAMARITAN_WOMAN = "local:JHN:n43004007002"
export const DISCIPLES = "local:JHN:n43004027006"
