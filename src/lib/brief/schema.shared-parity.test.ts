// AQU-1227 regression guard. The brief now has two writers: the in-app builder
// (BRIEF_FIELDS here, i18n-labelled) and the Agent API's SetBrief command,
// which validates section ids against the dependency-free db/shared/brief.ts
// spec. Field ids are the STORAGE contract — a drift between the two lists
// would make SetBrief reject a section the UI happily writes (or worse, accept
// one the UI never reads). Ordering matters too: both lists are the interview
// order, and the server assembles L2 markdown from its copy.

import { describe, it, expect } from "vitest"
import { BRIEF_FIELDS } from "./schema"
import { BRIEF_FIELD_SPECS } from "../../../db/shared/brief"

describe("brief schema — SPA / shared parity", () => {
  it("field ids and order match db/shared/brief.ts", () => {
    expect(BRIEF_FIELDS.map((f) => f.id)).toEqual(BRIEF_FIELD_SPECS.map((f) => f.id))
  })

  it("every field sits in the same group in both lists", () => {
    for (const [i, field] of BRIEF_FIELDS.entries()) {
      expect(BRIEF_FIELD_SPECS[i].group).toBe(field.group)
    }
  })
})
