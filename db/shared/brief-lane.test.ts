// AQU-2348: reading the brief that is IN FORCE for one target lane.
//
// The regression guard for the write half of per-lane Living Memory. Two
// properties matter more than the rest:
//
//   * A project with no per-lane briefs must read EXACTLY as it did before
//     this key existed, for every lane — that is what makes the feature need
//     no migration.
//   * The fallback is what turns "Customize for this lane" into a copy: the
//     first lane-scoped write merges onto the brief the lane resolves to, so a
//     lane starts life saying what the project said and then diverges.

import { describe, expect, it } from 'vitest'
import {
  BRIEF_BY_LANE_SETTINGS_KEY,
  BRIEF_SETTINGS_KEY,
  emptyBriefRecord,
  readBriefForLane,
  readBriefFromSettings,
  readLaneBriefMap,
  readOwnedBriefForLane,
  type TranslationBriefRecord,
} from './brief'

const ES = '0f0f0f0f'
const FR = 'a1a1a1a1'

function brief(overrides: Partial<TranslationBriefRecord> = {}): TranslationBriefRecord {
  return { ...emptyBriefRecord('author', '2026-11-03T00:00:00.000Z'), ...overrides }
}

const PROJECT_BRIEF = brief({ parameters: { purpose: 'Project purpose' }, l1Summary: 'Project L1' })
const ES_BRIEF = brief({ parameters: { purpose: 'Spanish purpose' }, l1Summary: 'Spanish L1' })

describe('readBriefForLane', () => {
  it('gives the project brief when no lane is asked for', () => {
    const settings = { [BRIEF_SETTINGS_KEY]: PROJECT_BRIEF }

    expect(readBriefForLane(settings, undefined)).toEqual({
      brief: readBriefFromSettings(settings),
      source: 'project',
    })
  })

  it('gives an uncustomized lane the project brief, sourced to the project', () => {
    const settings = { [BRIEF_SETTINGS_KEY]: PROJECT_BRIEF }

    const read = readBriefForLane(settings, ES)

    expect(read.source).toBe('project')
    expect(read.brief?.parameters.purpose).toBe('Project purpose')
  })

  it('gives a customized lane its own brief, sourced to the lane', () => {
    const settings = {
      [BRIEF_SETTINGS_KEY]: PROJECT_BRIEF,
      [BRIEF_BY_LANE_SETTINGS_KEY]: { [ES]: ES_BRIEF },
    }

    const read = readBriefForLane(settings, ES)

    expect(read.source).toBe('lane')
    expect(read.brief?.parameters.purpose).toBe('Spanish purpose')
    expect(read.brief?.l1Summary).toBe('Spanish L1')
  })

  it('leaves every other lane, and the project, reading the project brief', () => {
    const settings = {
      [BRIEF_SETTINGS_KEY]: PROJECT_BRIEF,
      [BRIEF_BY_LANE_SETTINGS_KEY]: { [ES]: ES_BRIEF },
    }

    expect(readBriefForLane(settings, FR).brief?.parameters.purpose).toBe('Project purpose')
    expect(readBriefForLane(settings, FR).source).toBe('project')
    expect(readBriefForLane(settings, undefined).brief?.parameters.purpose).toBe('Project purpose')
  })

  it('reads as it did before the key existed when a project has no lane briefs', () => {
    // No migration: the pre-AQU-2348 answer for every lane of every project.
    const settings = { [BRIEF_SETTINGS_KEY]: PROJECT_BRIEF }

    for (const laneId of [undefined, ES, FR, '']) {
      expect(readBriefForLane(settings, laneId).brief).toEqual(readBriefFromSettings(settings))
    }
  })

  it('answers "no brief" for a project that has none, whatever the lane', () => {
    expect(readBriefForLane({}, undefined).brief).toBeNull()
    expect(readBriefForLane({}, ES).brief).toBeNull()
  })

  it('falls back to the project when a lane entry is junk rather than a brief', () => {
    // A hand-edited blob must not cost a lane its brief: an unparseable entry
    // is not a customization, so the lane keeps inheriting.
    const settings = {
      [BRIEF_SETTINGS_KEY]: PROJECT_BRIEF,
      [BRIEF_BY_LANE_SETTINGS_KEY]: { [ES]: 'not a brief' },
    }

    const read = readBriefForLane(settings, ES)

    expect(read.source).toBe('project')
    expect(read.brief?.parameters.purpose).toBe('Project purpose')
  })
})

describe('readLaneBriefMap', () => {
  it('copies the stored map so a caller cannot mutate the loaded blob', () => {
    const stored = { [ES]: ES_BRIEF }
    const settings = { [BRIEF_BY_LANE_SETTINGS_KEY]: stored }

    const map = readLaneBriefMap(settings)
    map[FR] = PROJECT_BRIEF

    expect(Object.keys(stored)).toEqual([ES])
  })

  it('reads an absent or bent key as an empty map rather than throwing', () => {
    expect(readLaneBriefMap({})).toEqual({})
    expect(readLaneBriefMap({ [BRIEF_BY_LANE_SETTINGS_KEY]: 'nope' })).toEqual({})
    expect(readLaneBriefMap({ [BRIEF_BY_LANE_SETTINGS_KEY]: [1, 2] })).toEqual({})
  })
})

describe('readOwnedBriefForLane', () => {
  it('is null for a lane that only inherits', () => {
    const settings = { [BRIEF_SETTINGS_KEY]: PROJECT_BRIEF }

    // The distinction that matters for "is this plan already satisfied?": the
    // lane READS the project's brief but does not OWN one, and a lane-scoped
    // write was asked for exactly so the two can diverge later.
    expect(readBriefForLane(settings, ES).brief).not.toBeNull()
    expect(readOwnedBriefForLane(settings, ES)).toBeNull()
  })

  it('is the lane’s own copy once it has one', () => {
    const settings = {
      [BRIEF_SETTINGS_KEY]: PROJECT_BRIEF,
      [BRIEF_BY_LANE_SETTINGS_KEY]: { [ES]: ES_BRIEF },
    }

    expect(readOwnedBriefForLane(settings, ES)?.parameters.purpose).toBe('Spanish purpose')
    expect(readOwnedBriefForLane(settings, FR)).toBeNull()
  })

  it('is the project brief when no lane is named', () => {
    const settings = {
      [BRIEF_SETTINGS_KEY]: PROJECT_BRIEF,
      [BRIEF_BY_LANE_SETTINGS_KEY]: { [ES]: ES_BRIEF },
    }

    expect(readOwnedBriefForLane(settings, undefined)).toEqual(readBriefFromSettings(settings))
  })
})
