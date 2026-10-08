// AQU-1593: the language a model is told for a lane is the lane's typed
// `language`. AQU-1592 made `language` the required field and `name` optional,
// so a second lane is often a typed "Spanish" with no name and its own id as
// its tag. If the row loader leaves the column out, the rule never sees it and
// the model is told the project's target language instead.
import { describe, expect, it } from "vitest"
import type { AquillaDb } from "../shim/postgres"
import { languageOfTargetLane, modelLanguageForLane } from "./lane-language"

const P = "proj-1"
const LANE_ID = "a3f09c1e"

interface Row {
  id: string
  language: string | null
  name: string
  lang_code: string | null
  legacy_tag: string | null
}

/** Answers like Postgres would: a column the query does not select is absent. */
function fakeDb(row: Row): AquillaDb {
  const answer = (sql: string): unknown => {
    if (sql.includes("SELECT id, legacy_tag FROM lanes")) return { id: row.id, legacy_tag: row.legacy_tag }
    if (sql.includes("FROM lanes")) {
      const selected: Record<string, unknown> = { id: row.id, name: row.name, lang_code: row.lang_code, legacy_tag: row.legacy_tag }
      if (/\blanguage\b/.test(sql.slice(0, sql.indexOf("FROM")))) selected.language = row.language
      return selected
    }
    throw new Error(`unexpected sql: ${sql}`)
  }
  const stmt = (sql: string) => ({
    bind: () => stmt(sql),
    first: async () => answer(sql),
  })
  return { prepare: (sql: string) => stmt(sql) } as unknown as AquillaDb
}

const secondSpanishLane: Row = { id: LANE_ID, language: "Spanish", name: "", lang_code: null, legacy_tag: LANE_ID }

describe("languageOfTargetLane", () => {
  it("answers with the typed language when the lane has no name and its id as its tag", async () => {
    expect(await languageOfTargetLane(fakeDb(secondSpanishLane), P, LANE_ID)).toBe("Spanish")
  })

  it("prefers the typed language over a display name", async () => {
    const named = { ...secondSpanishLane, name: "Latin America team" }
    expect(await languageOfTargetLane(fakeDb(named), P, LANE_ID)).toBe("Spanish")
  })
})

describe("modelLanguageForLane", () => {
  it("tells the model the lane's language, not the project's target", async () => {
    const language = await modelLanguageForLane(
      fakeDb(secondSpanishLane),
      P,
      { laneId: LANE_ID, tag: LANE_ID },
      "French",
    )
    expect(language).toBe("Spanish")
  })
})
