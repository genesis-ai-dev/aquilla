// Test fixtures (AQU-1700): real Bible Knowledge Pack 1.2.0 data for the Old
// Testament, trimmed (see ./ATTRIBUTION.md): RUT 1–2, GEN 1–3 and PSA 23.
// Parsed with the pack client's own `parseLayer`, so a fixture the client
// would reject fails here first.

import gen13PeopleJson from "./bkp-v1.2-GEN-1-3.people.json?raw"
import gen13StructureJson from "./bkp-v1.2-GEN-1-3.structure.json?raw"
import psa23PeopleJson from "./bkp-v1.2-PSA-23.people.json?raw"
import psa23VoicesJson from "./bkp-v1.2-PSA-23.voices.json?raw"
import rutNotesJson from "./bkp-v1.2-RUT-1-2.notes.json?raw"
import rutPeopleJson from "./bkp-v1.2-RUT-1-2.people.json?raw"
import rutStructureJson from "./bkp-v1.2-RUT-1-2.structure.json?raw"
import rutTermsJson from "./bkp-v1.2-RUT-1-2.terms.json?raw"
import rutTextJson from "./bkp-v1.2-RUT-1-2.text.json?raw"
import rutVoicesJson from "./bkp-v1.2-RUT-1-2.voices.json?raw"
import maculaHebrewRut1Tsv from "./macula-hebrew-RUT-1.tsv?raw"
import {
  parseLayer,
  type BkpLayerData,
  type BkpNotesLayer,
  type BkpPeopleLayer,
  type BkpStructureLayer,
  type BkpTermsLayer,
  type BkpTextLayer,
  type BkpVoicesLayer,
} from "../pack-types"
import type { BkpLayer } from "../../../../db/shared/bible-enrichments"

/** The raw files, by the pack path they are served at (`/{layer}/{BOOK}.json`). */
export const OT_PACK12_FILES: Readonly<Record<string, string>> = {
  "/text/RUT.json": rutTextJson,
  "/structure/RUT.json": rutStructureJson,
  "/voices/RUT.json": rutVoicesJson,
  "/people/RUT.json": rutPeopleJson,
  "/notes/RUT.json": rutNotesJson,
  "/terms/RUT.json": rutTermsJson,
  "/structure/GEN.json": gen13StructureJson,
  "/people/GEN.json": gen13PeopleJson,
  "/voices/PSA.json": psa23VoicesJson,
  "/people/PSA.json": psa23PeopleJson,
}

/** Pack 1.2.0's manifest for these books, with the layers the fixtures hold. */
export const OT_PACK12_MANIFEST = {
  pack: "bkp",
  version: "1.2.0",
  builtAt: "2026-10-06T10:18:50.134Z",
  versification: "org",
  sources: [],
  layers: {},
  books: {
    RUT: { layers: ["text", "structure", "voices", "people", "notes", "terms"], bytes: {} },
    GEN: { layers: ["structure", "people"], bytes: {} },
    PSA: { layers: ["voices", "people"], bytes: {} },
  },
}

/**
 * Macula Hebrew's own TSV rows for RUT 1:1 and RUT 1:16 (pinned commit
 * 47db250b), one row per morpheme, with the SDBH columns blanked. What a
 * project's Macula import reads (src/lib/parsers/macula.ts).
 */
export const MACULA_HEBREW_RUT_1_TSV: string = maculaHebrewRut1Tsv

function parsed<L extends BkpLayer>(layer: L, book: string, raw: string, file: string): BkpLayerData[L] {
  const data = parseLayer(layer, book, JSON.parse(raw))
  if (!data) throw new Error(`${file} is not a ${layer} layer for ${book}`)
  return data
}

/** The morphemes of RUT 1:1, 1:8 and 1:14–17. */
export function rutText(): BkpTextLayer {
  return parsed("text", "RUT", rutTextJson, "bkp-v1.2-RUT-1-2.text.json")
}

/** The voices of RUT 1–2, with the speeches they use. */
export function rutVoices(): BkpVoicesLayer {
  return parsed("voices", "RUT", rutVoicesJson, "bkp-v1.2-RUT-1-2.voices.json")
}

/** Every mention in RUT 1–2. */
export function rutPeople(): BkpPeopleLayer {
  return parsed("people", "RUT", rutPeopleJson, "bkp-v1.2-RUT-1-2.people.json")
}

/** RUT 1–2's three SIL OTN sections and verse flags. No moves: the OT has none. */
export function rutStructure(): BkpStructureLayer {
  return parsed("structure", "RUT", rutStructureJson, "bkp-v1.2-RUT-1-2.structure.json")
}

/** The notes and questions of the text fixture's verses. */
export function rutNotes(): BkpNotesLayer {
  return parsed("notes", "RUT", rutNotesJson, "bkp-v1.2-RUT-1-2.notes.json")
}

/** The tagged morphemes of the text fixture's verses, and their terms. */
export function rutTerms(): BkpTermsLayer {
  return parsed("terms", "RUT", rutTermsJson, "bkp-v1.2-RUT-1-2.terms.json")
}

/** Every mention in GEN 1–3. */
export function genPeople(): BkpPeopleLayer {
  return parsed("people", "GEN", gen13PeopleJson, "bkp-v1.2-GEN-1-3.people.json")
}

/** GEN 1–3's verse flags. Genesis has no segments in the pack. */
export function genStructure(): BkpStructureLayer {
  return parsed("structure", "GEN", gen13StructureJson, "bkp-v1.2-GEN-1-3.structure.json")
}

/** A verse as a Macula Hebrew import stores it: the morphemes that have letters, joined by single spaces. */
export function maculaHebrewImportText(text: BkpTextLayer, ref: string): string {
  return text.verses[ref]
    .map((id) => text.words[id].text)
    .filter((form) => form !== "")
    .join(" ")
}

export const RUTH = "person:Ruth"
export const NAOMI = "person:Naomi"
export const LORD = "deity:Lord"
/** RUT 1:16–17 "Do not urge me to leave you …": Ruth to Naomi, one speech over two verses. */
export const RUTH_SPEECH_1_16 = "sp:o080010160031-o080010170163"
/** RUT 1:16 בִּי "me": the suffix ־ִי of בִּי, which refers to Ruth. */
export const ME_1_16 = "o080010160052"
/** RUT 1:16 בִּי "to": the preposition that hosts the suffix. */
export const BI_1_16 = "o080010160051"
/** RUT 1:1 בָּאָרֶץ "in the land": the article Macula split off, with no letters of its own. */
export const IMPLIED_ARTICLE_1_1 = "o080010010071ה"
/** RUT 1:1 "in the land": anchored on בָּאָרֶץ, its implied article included. */
export const LAND_NOTE_1_1 = "tn:278455"
/** RUT 1:16 "forsake you … turn back from behind you": a doublet, anchored on eight morphemes. */
export const DOUBLET_NOTE_1_16 = "tn:278505"
/** RUT 1:16 "and where you live": no quote, so no anchor. */
export const QUOTELESS_NOTE_1_16 = "tn:278504"
/** RUT 1:8: quotes the Ketiv יעשה, which Macula (the Qere) does not have, so it is unanchored. */
export const KETIV_NOTE_1_8 = "tn:278474"
/** RUT 1:16 "When Ruth stayed with Naomi, what promise did Ruth make to Naomi?" */
export const QUESTION_1_16 = "tq:179062"
/** RUT 1:6–22, an SIL OTN section. */
export const RETURN_SECTION = "seg:o080010060011-o080010220161"
/** GEN 3's unnamed serpent. */
export const SERPENT = "local:GEN:o010030010013"
