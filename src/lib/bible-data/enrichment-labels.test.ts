// AQU-1686: registry ↔ catalog parity for the Bible data card.
//
// The shared registry adds an id; the card renders `t(labelKey)` for it. A key
// missing from the catalog would show a raw key to a maintainer, and two ids
// sharing a key would make two rows look like one setting.

import { describe, it, expect } from "vitest"
import { en, type MessageKey } from "@/lib/i18n/messages/en"
import {
  BIBLE_DATA_SOURCE_IDS,
  BIBLE_ENRICHMENT_IDS,
} from "../../../db/shared/bible-enrichments"
import {
  BIBLE_DATA_SOURCE_NAME_KEYS,
  BIBLE_DATA_SOURCE_SHORT_NAME_KEYS,
  BIBLE_ENRICHMENT_DESCRIPTION_KEYS,
  BIBLE_ENRICHMENT_LABEL_KEYS,
} from "./enrichment-labels"

const english = (key: MessageKey): unknown => (en as Record<string, unknown>)[key]

function expectCatalogString(key: MessageKey | undefined, what: string) {
  expect(key, `${what} has no key`).toBeDefined()
  const value = english(key as MessageKey)
  expect(typeof value, `${what} → ${key} is not in the catalog`).toBe("string")
  expect((value as string).trim().length, `${what} → ${key} is empty`).toBeGreaterThan(0)
}

describe("Bible data enrichment labels", () => {
  it("gives every enrichment a label and a description in the catalog", () => {
    for (const id of BIBLE_ENRICHMENT_IDS) {
      expectCatalogString(BIBLE_ENRICHMENT_LABEL_KEYS[id], `${id} label`)
      expectCatalogString(BIBLE_ENRICHMENT_DESCRIPTION_KEYS[id], `${id} description`)
    }
  })

  it("never shares a label or a description between two enrichments", () => {
    const labels = BIBLE_ENRICHMENT_IDS.map((id) => BIBLE_ENRICHMENT_LABEL_KEYS[id])
    const descriptions = BIBLE_ENRICHMENT_IDS.map((id) => BIBLE_ENRICHMENT_DESCRIPTION_KEYS[id])
    expect(new Set(labels).size).toBe(BIBLE_ENRICHMENT_IDS.length)
    expect(new Set(descriptions).size).toBe(BIBLE_ENRICHMENT_IDS.length)
    for (const id of BIBLE_ENRICHMENT_IDS) {
      expect(BIBLE_ENRICHMENT_LABEL_KEYS[id]).not.toBe(BIBLE_ENRICHMENT_DESCRIPTION_KEYS[id])
    }
  })

  // The spec asks for a description of at least one sentence, not a fragment.
  it("describes each enrichment in a full sentence", () => {
    for (const id of BIBLE_ENRICHMENT_IDS) {
      const text = english(BIBLE_ENRICHMENT_DESCRIPTION_KEYS[id]) as string
      expect(text, id).toMatch(/\.$/)
    }
  })

  // Attribution: every dataset the chip or the Data sources dialog names
  // must render as a real name.
  it("names every data source, in full and in short", () => {
    for (const id of BIBLE_DATA_SOURCE_IDS) {
      expectCatalogString(BIBLE_DATA_SOURCE_NAME_KEYS[id], `${id} name`)
      expectCatalogString(BIBLE_DATA_SOURCE_SHORT_NAME_KEYS[id], `${id} short name`)
    }
  })
})
