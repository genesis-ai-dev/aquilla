// Test fixtures (AQU-1695): real Bible Knowledge Pack 1.1.0 data for John,
// trimmed (see ./ATTRIBUTION.md). Parsed with the pack client's own
// `parseLayer`, so a fixture the client would reject fails here first.

import notesJson from "./bkp-v1.1-JHN-4.notes.json?raw"
import peopleJson from "./bkp-v1.1-JHN-4.people.json?raw"
import termsJson from "./bkp-v1.1-JHN-4.terms.json?raw"
import textJson from "./bkp-v1.1-JHN-4.text.json?raw"
import {
  parseLayer,
  type BkpNotesLayer,
  type BkpPeopleLayer,
  type BkpTermsLayer,
  type BkpTextLayer,
} from "../pack-types"

/** The raw files, for tests that serve them over a stubbed fetch. */
export const JHN4_11_NOTES_JSON: string = notesJson
export const JHN4_11_PEOPLE_JSON: string = peopleJson
export const JHN4_11_TERMS_JSON: string = termsJson
export const JHN4_11_TEXT_JSON: string = textJson

/** The notes and questions of the text fixture's verses, and the JHN 1:40–42 range note. */
export function jhn4Notes11(): BkpNotesLayer {
  const layer = parseLayer("notes", "JHN", JSON.parse(notesJson))
  if (!layer) throw new Error("bkp-v1.1-JHN-4.notes.json is not a notes layer for JHN")
  return layer
}

/** Every mention in JHN 4 and JHN 5:12, with descriptions, kin and `via`. */
export function jhn4People11(): BkpPeopleLayer {
  const layer = parseLayer("people", "JHN", JSON.parse(peopleJson))
  if (!layer) throw new Error("bkp-v1.1-JHN-4.people.json is not a people layer for JHN")
  return layer
}

/** The tagged words of the text fixture's verses, and their terms. */
export function jhn4Terms11(): BkpTermsLayer {
  const layer = parseLayer("terms", "JHN", JSON.parse(termsJson))
  if (!layer) throw new Error("bkp-v1.1-JHN-4.terms.json is not a terms layer for JHN")
  return layer
}

/** The words of JHN 4:5, 4:6, 4:9–11, 4:14, 4:51 and 5:12. */
export function jhn4Text11(): BkpTextLayer {
  const layer = parseLayer("text", "JHN", JSON.parse(textJson))
  if (!layer) throw new Error("bkp-v1.1-JHN-4.text.json is not a text layer for JHN")
  return layer
}

/** The verses of the text fixture, in order. */
export const PACK11_VERSES = ["4:5", "4:6", "4:9", "4:10", "4:11", "4:14", "4:51", "5:12"] as const

/** JHN 4:9 "πῶς σὺ Ἰουδαῖος ὢν …": a rhetorical question, anchored on 11 words. */
export const RQUESTION_NOTE_4_9 = "tn:211089"
/** JHN 4:9 "οὐ & συνχρῶνται": anchored on two words that do not touch. */
export const SPLIT_NOTE_4_9 = "tn:211090"
/** JHN 4:11, General Information about "Sir": no quote, so no anchor. */
export const QUOTELESS_NOTE_4_11 = "tn:211098"
/** JHN 4:51 "αὐτοῦ": found in more than one place, so not highlighted. */
export const AMBIGUOUS_NOTE_4_51 = "tn:211204"
/** JHN 5:12 "ἠρώτησαν αὐτόν": UGNT word order, not found in SBLGNT. */
export const UNANCHORED_NOTE_5_12 = "tn:211236"
/** JHN 1:40–42, General Information: a note on a range of verses. */
export const RANGE_NOTE_1_40 = "tn:210821"
/** JHN 4:9 "Why was the Samaritan woman surprised …?" */
export const QUESTION_4_9 = "tq:172802"
/** JHN 4:14–15 "What does Jesus tell the woman about the water …?" */
export const RANGE_QUESTION_4_14 = "tq:172805"

/** Jacob (ACAI's "Israel"), named in JHN 4:5, 4:6 and 4:12. His sons Joseph and Levi are his kin. */
export const ISRAEL = "person:Israel"
/** Joseph the patriarch, named in JHN 4:5. */
export const JOSEPH_10 = "person:Joseph.10"
/** Levi, son of Jacob: in John's entity map as kin, never mentioned in this fixture. */
export const LEVI_3 = "person:Levi.3"
/** "water" in JHN 4:10–11: a `local-thing`, never a participant. */
export const WATER = "local:JHN:n43004010029"
/** τοῦ Θεοῦ in JHN 4:10: ACAI's `deity:Lord`, labelled "LORD". */
export const THEOU_4_10 = "n43004010011"
/** λέγων in JHN 4:10, the word αὐτόν's chain goes through ("via"). */
export const LEGON_4_10 = "n43004010016"
