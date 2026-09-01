// AQU-646 stage 2: which `file.track.set` patches need the project to have
// opted into track editing.
//
// One event kind carries every timeline operation — reorder, rename, create,
// delete, folder move, recolour — so the split between "ordinary maintainer
// work" and "restructuring" is decided by reading the PAYLOAD. That makes it a
// pure function, and a pure function is the only part of this gate that can be
// pinned without minting a JWT or standing up a fake database. Its sibling
// (line-creation-authority.ts) has no such seam, which is why its own test has
// to fake a whole DB to assert a policy decision.

import { describe, it, expect } from 'vitest'
import { isGatedTrackPatch, trackPatchRequiresExisting } from '../events/track-editing-authority'

/** The payload shape `file.track.set` carries on the wire. */
const withPatch = (patch: unknown) => ({ trackId: 'trk-1', patch })

describe('isGatedTrackPatch — the ungated half', () => {
  // Every one of these already ships. A setting that defaults OFF must not
  // silently take an existing capability away from every project that has one,
  // which is the whole reason the gate reads the patch instead of the kind.
  const ungated: Array<[string, unknown]> = [
    ['a drag-to-reorder', { order: 2 }],
    ['a fractional reorder (a drop between two rows)', { order: 1.5 }],
    ['a negative reorder (a drop above the first row)', { order: -1 }],
    ['a rename', { name: 'Spanish VO' }],
    ['clearing a rename back to the default label', { name: null }],
    ['clearing an order back to the derived seat', { order: null }],
    ['a rename and a reorder together', { name: 'Spanish VO', order: 2 }],
  ]

  for (const [label, patch] of ungated) {
    it(`lets ${label} through`, () => {
      expect(isGatedTrackPatch(withPatch(patch))).toBe(false)
    })
  }
})

describe('isGatedTrackPatch — the gated half', () => {
  const gated: Array<[string, unknown]> = [
    ['creating a track', { kind: 'audio', name: 'Spanish VO', order: 4, sourceTrackId: 'source-subtitles' }],
    ['creating a folder', { kind: 'folder', name: 'Dubs' }],
    ['recolouring', { color: 'teal' }],
    ['clearing a colour', { color: null }],
    ['setting an alignment', { sourceTrackId: 'source-subtitles' }],
    ['ejecting a track from its folder', { groupId: null }],
    // THE ONE THAT LOOKS UNGATED AND IS NOT. A folder drop writes both fields
    // in one patch, because a rejected second event would leave the track half
    // moved — and moving a track into a folder IS folder editing, so the
    // presence of `order` must not launder it.
    ['a folder drop, which rides an order with it', { order: 1.5, groupId: 'grp-1' }],
  ]

  for (const [label, patch] of gated) {
    it(`gates ${label}`, () => {
      expect(isGatedTrackPatch(withPatch(patch))).toBe(true)
    })
  }

  // THE CLAUSE THAT HAS TO BE WRITTEN OUT SEPARATELY. The tempting one-line
  // rule — "ungated iff the keys are a subset of {name, order}" — is wrong in
  // the PERMISSIVE direction here: null has no keys at all, so it is vacuously
  // a subset and the delete sails through the gate that exists to stop it.
  it('gates a delete, which has no keys to be a subset of anything', () => {
    expect(isGatedTrackPatch(withPatch(null))).toBe(true)
  })

  // "Reset this row to its defaults" reads innocently, but the projection
  // implements it as `meta #- ARRAY['trackOverrides', <id>]` — it drops the
  // WHOLE entry — so resetting the dub row also clears its colour, its group
  // and its rename in one write. Three of those four are gated fields.
  it('gates a reset on a DERIVED track, which clears its colour and group too', () => {
    expect(isGatedTrackPatch({ trackId: 'target-audio', patch: null })).toBe(true)
  })
})

describe('isGatedTrackPatch — malformed input', () => {
  // The handler refuses all of these a moment later with a precise reason. The
  // only thing this decides is whether one could ever slip through as
  // "ordinary maintainer work" during a version skew. None can.
  const malformed: Array<[string, unknown]> = [
    ['a missing patch key', { trackId: 'trk-1' }],
    ['an undefined patch', withPatch(undefined)],
    ['a string patch', withPatch('name')],
    ['an array patch', withPatch([])],
    ['a non-object payload', 'nonsense'],
    ['a null payload', null],
    ['an unknown key a newer client invented', withPatch({ opacity: 0.5 })],
  ]

  for (const [label, payload] of malformed) {
    it(`gates ${label}`, () => {
      expect(isGatedTrackPatch(payload)).toBe(true)
    })
  }
})

// ── A write that cannot create a track must find one (2026-08-27) ──────────
//
// `{order: 1}` for an id that does not exist used to merge a kind-less entry
// into files.meta.trackOverrides. `mergeTrackOverrides` skips it when
// rendering (`isTrackKind(patch.kind)` fails), so it was invisible in the UI,
// untargetable by any control, and unremovable — removal is `patch: null`,
// which IS gated. Creation ungated, deletion gated, on a blob read on every
// file listing.
describe('trackPatchRequiresExisting', () => {
  const ADDED = '019fd21a-a5a4-75d1-b8c4-3b60072a4fc2'

  it('requires an existing track for a patch that cannot create one', () => {
    // Both of the ungated keys had the same hole, not just `order`.
    expect(trackPatchRequiresExisting(ADDED, { order: 1 })).toBe(true)
    expect(trackPatchRequiresExisting(ADDED, { name: 'Spanish' })).toBe(true)
    expect(trackPatchRequiresExisting(ADDED, { name: 'Spanish', order: 1 })).toBe(true)
    // …and the gated keys could write the same junk with the setting ON.
    expect(trackPatchRequiresExisting(ADDED, { color: 'cyan' })).toBe(true)
    expect(trackPatchRequiresExisting(ADDED, { groupId: 'grp' })).toBe(true)
  })

  it('lets a patch carrying `kind` create the track it names', () => {
    expect(trackPatchRequiresExisting(ADDED, { kind: 'audio', name: 'Spanish', order: 1 })).toBe(false)
    expect(trackPatchRequiresExisting(ADDED, { kind: 'folder', name: 'Dubs' })).toBe(false)
  })

  // The derived rows have no entry until their FIRST rename or reorder, and
  // drag-to-reorder is deliberately left working with the setting off — so
  // requiring an entry there would take away a shipped capability.
  it('exempts the derived rows, whose first write legitimately has no entry', () => {
    for (const id of ['source-subtitles', 'source-audio', 'target-subtitles', 'target-audio']) {
      expect(trackPatchRequiresExisting(id, { order: 2 }), id).toBe(false)
    }
  })

  // A delete is gated by `isGatedTrackPatch` clause 1; it is not this rule's
  // business, and demanding existence for it would be a second gate.
  it('says nothing about a delete', () => {
    expect(trackPatchRequiresExisting(ADDED, null)).toBe(false)
    expect(trackPatchRequiresExisting(ADDED, undefined)).toBe(false)
  })

  it('ignores a patch that is not an object', () => {
    expect(trackPatchRequiresExisting(ADDED, 'nope')).toBe(false)
    expect(trackPatchRequiresExisting(ADDED, [1, 2])).toBe(false)
  })
})
