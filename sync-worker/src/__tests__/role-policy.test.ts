import { describe, it, expect } from "vitest"
import { ROLE, REQUIRED_ROLE, requiredRoleFor } from "../events/role-policy"
import { emitEventsFloor } from "../external/commands-emit-events"
import type { EventKind } from "../events/types"

describe("requiredRoleFor — target.* (translator)", () => {
  it("returns CONTRIBUTOR for target.cell.create", () => {
    expect(requiredRoleFor('target.cell.create')).toBe(ROLE.CONTRIBUTOR)
  })

  it("returns CONTRIBUTOR for target.cell.commit", () => {
    expect(requiredRoleFor('target.cell.commit')).toBe(ROLE.CONTRIBUTOR)
  })

  it("returns CONTRIBUTOR for target.cell.delete", () => {
    expect(requiredRoleFor('target.cell.delete')).toBe(ROLE.CONTRIBUTOR)
  })

  it("returns CONTRIBUTOR for target.cell.reorder", () => {
    expect(requiredRoleFor('target.cell.reorder')).toBe(ROLE.CONTRIBUTOR)
  })
})

describe("requiredRoleFor — source.* (importer / admin)", () => {
  // AQU-1068: create/delete sit at COMMENTER. Lowered from CONTRIBUTOR when
  // the tier list was rebuilt on the product's standard ladder (Matthew's
  // review, Sam approved 2026-09-08), because at CONTRIBUTOR the new Commenter
  // and Reviewer tiers could not admit anyone at all.
  //
  // SINCE 2026-09-09 THIS TABLE IS THE ONLY SERVER FLOOR ON THESE KINDS. The
  // project's `cellEditingFloor` used to sit on top of it inside authorize();
  // it is now a product rule enforced at the button, because checking it here
  // silently refused audio-cue re-import, DCS upstream import and diarization
  // (see authorize.ts). So these assertions carry more weight than they did:
  // raising this floor back would break the two lowest tiers, and lowering it
  // would admit a viewer outright.
  it("returns COMMENTER for source.cell.create — the only server floor on it", () => {
    expect(requiredRoleFor('source.cell.create')).toBe(ROLE.COMMENTER)
  })

  it("returns PROJECT_LEAD for source.cell.commit", () => {
    expect(requiredRoleFor('source.cell.commit')).toBe(ROLE.PROJECT_LEAD)
  })

  it("returns COMMENTER for source.cell.delete — the user-inserted guard lives in authorize", () => {
    expect(requiredRoleFor('source.cell.delete')).toBe(ROLE.COMMENTER)
  })

  it("returns COMMENTER for source.cell.reorder — it rides every add/remove batch", () => {
    expect(requiredRoleFor('source.cell.reorder')).toBe(ROLE.COMMENTER)
  })
})

describe("requiredRoleFor — cell audio", () => {
  // AQU-646 depends on this floor: transcription rides cell.audio.attach
  // precisely so contributors (translators) can transcribe imported segments.
  // Raising this floor would silently break the transcribe workflow.
  it("returns CONTRIBUTOR for cell.audio.attach", () => {
    expect(requiredRoleFor('cell.audio.attach')).toBe(ROLE.CONTRIBUTOR)
  })
})

describe("requiredRoleFor — validation", () => {
  it("returns REVIEWER for cell.validate", () => {
    expect(requiredRoleFor('cell.validate')).toBe(ROLE.REVIEWER)
  })

  it("returns REVIEWER for cell.unvalidate", () => {
    expect(requiredRoleFor('cell.unvalidate')).toBe(ROLE.REVIEWER)
  })
})

describe("requiredRoleFor — file.create", () => {
  it("returns PROJECT_LEAD for file.create", () => {
    expect(requiredRoleFor('file.create')).toBe(ROLE.PROJECT_LEAD)
  })
})

describe("requiredRoleFor — assignment.* (manager)", () => {
  it("returns PROJECT_LEAD for assignment.create", () => {
    expect(requiredRoleFor('assignment.create')).toBe(ROLE.PROJECT_LEAD)
  })

  it("returns PROJECT_LEAD for assignment.reassign", () => {
    expect(requiredRoleFor('assignment.reassign')).toBe(ROLE.PROJECT_LEAD)
  })

  it("returns PROJECT_LEAD for assignment.unassign", () => {
    expect(requiredRoleFor('assignment.unassign')).toBe(ROLE.PROJECT_LEAD)
  })
})

describe("REQUIRED_ROLE table completeness", () => {
  it("has an entry for every EventKind", () => {
    const keys = Object.keys(REQUIRED_ROLE) as EventKind[]
    expect(keys.length).toBeGreaterThan(0)
    for (const kind of keys) {
      expect(typeof REQUIRED_ROLE[kind]).toBe("number")
      expect(REQUIRED_ROLE[kind]).toBeGreaterThanOrEqual(100)
      expect(REQUIRED_ROLE[kind]).toBeLessThanOrEqual(700)
    }
  })

  it("covers all current EventKind values explicitly (no implicit ROLE)", () => {
    const expected: EventKind[] = [
      'source.cell.create',
      'source.cell.commit',
      'source.cell.delete',
      'source.cell.reorder',
      'target.cell.create',
      'target.cell.commit',
      'target.cell.delete',
      'target.cell.reorder',
      'cell.validate',
      'cell.unvalidate',
      'file.create',
    ]
    for (const kind of expected) {
      expect(REQUIRED_ROLE).toHaveProperty(kind)
    }
  })
})

describe("ROLE constants", () => {
  it("are ordered from lowest to highest privilege", () => {
    expect(ROLE.VIEWER).toBeLessThan(ROLE.COMMENTER)
    expect(ROLE.COMMENTER).toBeLessThan(ROLE.REVIEWER)
    expect(ROLE.REVIEWER).toBeLessThan(ROLE.CONTRIBUTOR)
    expect(ROLE.CONTRIBUTOR).toBeLessThan(ROLE.PROJECT_LEAD)
    expect(ROLE.PROJECT_LEAD).toBeLessThan(ROLE.MAINTAINER)
    expect(ROLE.MAINTAINER).toBeLessThan(ROLE.OWNER)
  })

  it("match the expected numeric values", () => {
    expect(ROLE.VIEWER).toBe(100)
    expect(ROLE.COMMENTER).toBe(200)
    expect(ROLE.REVIEWER).toBe(300)
    expect(ROLE.CONTRIBUTOR).toBe(400)
    expect(ROLE.PROJECT_LEAD).toBe(500)
    expect(ROLE.MAINTAINER).toBe(600)
    expect(ROLE.OWNER).toBe(700)
  })
})

// AQU-1068, 2026-09-09: the external surface's floor for cell structure.
//
// This used to be belt-and-braces. `emitEventsFloor` hard-codes PROJECT_LEAD
// for create/delete/reorder as a prepare-time fail-fast, and the project's
// `cellEditingFloor` was checked again per event at the /events perimeter.
// The tier stopped being checked there, and the external surface was exempt
// from it anyway (`src === 'external'`), so this hard-coded number is now the
// ONLY thing holding an integration above the COMMENTER static floor for these
// three kinds.
//
// Nothing else fails if somebody replaces it with `REQUIRED_ROLE[kind]` while
// tidying — the code reads like a redundant special case. It is not. Hence
// these three assertions.
describe("emitEventsFloor — the external surface's floor on cell structure", () => {
  const cmd = (...kinds: string[]) =>
    ({ kind: 'EmitEvents', events: kinds.map((k) => ({ kind: k })) }) as never

  it("holds source.cell.create at PROJECT_LEAD, above its COMMENTER static floor", () => {
    expect(emitEventsFloor(cmd('source.cell.create'))).toBe(ROLE.PROJECT_LEAD)
    expect(requiredRoleFor('source.cell.create')).toBe(ROLE.COMMENTER)
  })

  it("holds source.cell.delete and source.cell.reorder there too", () => {
    expect(emitEventsFloor(cmd('source.cell.delete'))).toBe(ROLE.PROJECT_LEAD)
    expect(emitEventsFloor(cmd('source.cell.reorder'))).toBe(ROLE.PROJECT_LEAD)
  })

  it("takes the max across a mixed batch, so one structural event lifts it", () => {
    expect(emitEventsFloor(cmd('target.cell.commit'))).toBe(ROLE.CONTRIBUTOR)
    expect(emitEventsFloor(cmd('target.cell.commit', 'source.cell.create'))).toBe(ROLE.PROJECT_LEAD)
  })
})
