import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import {
  BIBLICA_ETT_ORG_NAME,
  DEFAULT_SOURCE_TEXT_FLOOR,
  effectiveSourceTextFloor,
  meetsSourceTextFloor,
  sourceTextAuthorityLevel,
  sourceTextFloorLevel,
  sourceTextTierForExistingOrg,
} from "./source-text-floor"

describe("source text floor (AQU-2647)", () => {
  it("reads an absent or unknown tier as maintainer", () => {
    expect(DEFAULT_SOURCE_TEXT_FLOOR).toBe(600)
    for (const tier of [undefined, null, "", "owner", "reviewer", 500, { tier: "contributor" }]) {
      expect(sourceTextFloorLevel(tier)).toBe(600)
      expect(effectiveSourceTextFloor(tier, tier)).toBe(600)
    }
  })

  it("maps the three rungs, and a project's own tier wins over the organization's", () => {
    expect(sourceTextFloorLevel("contributor")).toBe(400)
    expect(sourceTextFloorLevel("project_lead")).toBe(500)
    expect(sourceTextFloorLevel("maintainer")).toBe(600)
    expect(effectiveSourceTextFloor("contributor", "maintainer")).toBe(400)
    expect(effectiveSourceTextFloor(undefined, "project_lead")).toBe(500)
    expect(effectiveSourceTextFloor("not-a-tier", "contributor")).toBe(400)
    expect(effectiveSourceTextFloor(undefined, undefined)).toBe(600)
  })

  it("keeps only the organization named exactly Biblica ETT at Project Lead", () => {
    expect(BIBLICA_ETT_ORG_NAME).toBe("Biblica ETT")
    expect(sourceTextTierForExistingOrg("Biblica ETT")).toBe("project_lead")
    for (const name of ["Biblica", "biblica ett", "Biblica ETT ", "ETT", "", null, undefined]) {
      expect(sourceTextTierForExistingOrg(name)).toBe("maintainer")
    }
  })

  it("the migration matches that name and does not name a project or a user", () => {
    const migration = readFileSync(
      path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "../postgres/migrations/0207_source_text_floor.sql",
      ),
      "utf8",
    )
    expect(migration).toContain(`name = '${BIBLICA_ETT_ORG_NAME}'`)
    expect(migration).toContain('"sourceTextFloor":"project_lead"')
    expect(migration).not.toMatch(/WHERE[^;]*project_id\s*=/)
    expect(migration).not.toMatch(/WHERE[^;]*user_id\s*=/)
    const schema = readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../postgres/schema.sql"),
      "utf8",
    )
    expect(schema).toContain("wp_source_text_floor")
    expect(schema).not.toMatch(/organizations[\s\S]{0,400}name TEXT[^,\n]*UNIQUE/)
  })

  it.each([
    ["project role Project Lead, no lane grant", 500, [], 500, true],
    ["project role Project Lead, no lane grant", 500, [], 600, false],
    ["project role Contributor, no lane grant", 400, [], 400, true],
    ["project role Contributor, no lane grant", 400, [], 500, false],
    ["Project Lead on one lane, viewer on the project", 100, [500], 500, true],
    ["Project Lead on one lane, viewer on the project", 100, [500], 600, false],
    ["Contributor on one lane, viewer on the project", 100, [400], 400, true],
    ["Contributor on one lane, viewer on the project", 100, [400], 500, false],
    ["Contributor on one lane, viewer on the project", 100, [400], 600, false],
    ["maintainer meets every offered floor", 600, [], 600, true],
    ["owner meets every offered floor", 700, [], 400, true],
    ["a lane grant does not lower a higher project role", 600, [400], 600, true],
  ] as const)("%s at floor %s", (_label, projectRole, laneLevels, floor, allowed) => {
    const authority = sourceTextAuthorityLevel({ projectRole, laneLevels: [...laneLevels] })
    expect(meetsSourceTextFloor(authority, floor)).toBe(allowed)
  })
})
