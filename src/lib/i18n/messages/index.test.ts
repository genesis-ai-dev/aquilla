// AQU-2090: only English ships with the app; every other catalog is fetched on demand.
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { CATALOGS } from "./all"
import { answerFromCatalogsForTests, catalogFor, CATALOG_LOCALES, loadCatalog } from "./index"
import { LOCALES } from "../locales"

describe("on-demand catalogs", () => {
  // The suite's setup answers from every catalog at once; test the real fetching.
  beforeAll(() => answerFromCatalogsForTests(null))
  afterAll(() => answerFromCatalogsForTests(CATALOGS))

  it("can fetch every locale the tooling knows, and nothing else", () => {
    expect([...CATALOG_LOCALES].sort()).toEqual(Object.keys(CATALOGS).sort())
  })

  it("covers every locale the language picker offers", () => {
    for (const { code } of LOCALES) expect(CATALOG_LOCALES).toContain(code)
  })

  it("has English from the start and fetches the others once", async () => {
    expect(catalogFor("en")).toBe(CATALOGS.en)
    expect(catalogFor("fr")).toBeUndefined()
    const first = await loadCatalog("fr")
    expect(first).toEqual(CATALOGS.fr)
    expect(catalogFor("fr")).toBe(first)
    expect(await loadCatalog("fr")).toBe(first)
  })

  it("resolves a locale with no catalog of its own to undefined (it reads English)", async () => {
    expect(await loadCatalog("xx")).toBeUndefined()
  })
})
