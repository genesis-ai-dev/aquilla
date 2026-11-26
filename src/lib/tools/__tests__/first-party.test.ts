import { describe, expect, it } from "vitest"
import { FIRST_PARTY_TOOLS, firstPartyToolId } from "../../../../shared/tools/first-party/index"
import { FIRST_PARTY_DOOR43_IMPORTER } from "../../../../shared/tools/first-party/door43-importer"

describe("first-party Smart Extensions registry", () => {
  it("ships Door43 importer and does not ship a duplicate default-editor extension", () => {
    expect(FIRST_PARTY_TOOLS[FIRST_PARTY_DOOR43_IMPORTER]).toBeDefined()
    expect("default-editor" in FIRST_PARTY_TOOLS).toBe(false)
  })

  it("produces deterministic UUIDv5-shaped ids per (project, key)", async () => {
    const a = await firstPartyToolId("p1", FIRST_PARTY_DOOR43_IMPORTER)
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(await firstPartyToolId("p1", FIRST_PARTY_DOOR43_IMPORTER)).toBe(a)
    expect(await firstPartyToolId("p2", FIRST_PARTY_DOOR43_IMPORTER)).not.toBe(a)
  })
})
