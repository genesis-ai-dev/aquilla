// AQU-2214: adding a track is ON by default, and this is the client half of
// that rule — the gate that decides which controls the timeline OFFERS.
//
// The pair that matters is the first two: unset reads ON (the default Sam
// flipped after the ETEN demo), and an explicit `false` still reads OFF. A flip
// that could not tell those apart would have overwritten every project and org
// that had already answered.
//
// The worker half is sync-worker's `resolveAllowTrackEditing`
// (src/__tests__/media-org-defaults.test.ts). They must agree: a button this
// gate offers and the perimeter refuses is a 403 the user cannot act on.

import { describe, it, expect } from "vitest"
import { canRestructureTracks } from "./project-workspace-helpers"
import { ROLE } from "@/lib/frontier/roles"

describe("canRestructureTracks — AQU-2214's default, and the gate it did not remove", () => {
  it("offers restructuring to a maintainer on a project that never set it", () => {
    expect(canRestructureTracks({ roleLevel: ROLE.MAINTAINER, allowTrackEditing: undefined })).toBe(true)
  })

  it("withholds it when the project (or its org) turned it off", () => {
    expect(canRestructureTracks({ roleLevel: ROLE.MAINTAINER, allowTrackEditing: false })).toBe(false)
  })

  it("withholds it from an OWNER when it is off — two gates means two gates", () => {
    expect(canRestructureTracks({ roleLevel: ROLE.OWNER, allowTrackEditing: false })).toBe(false)
  })

  it("keeps the maintainer floor with the setting on", () => {
    expect(canRestructureTracks({ roleLevel: ROLE.PROJECT_LEAD, allowTrackEditing: true })).toBe(false)
    expect(canRestructureTracks({ roleLevel: ROLE.PROJECT_LEAD, allowTrackEditing: undefined })).toBe(false)
    expect(canRestructureTracks({ roleLevel: ROLE.MAINTAINER, allowTrackEditing: true })).toBe(true)
  })

  // A project that has not arrived yet reads role 0, which is the honest
  // resting state: the new default must not flash the controls on before the
  // caller's clearance is known.
  it("withholds it while the project has not loaded", () => {
    expect(canRestructureTracks({ roleLevel: 0, allowTrackEditing: undefined })).toBe(false)
  })
})
