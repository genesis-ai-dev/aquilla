// AQU-1566: the shared counting rule must name exactly the roles the editor
// hides, and the plan board must keep counting with it. Either drifting would
// put a file in one total and not another on the same screen.
import { describe, expect, it } from "vitest"
import {
  HIDDEN_FILE_ROLES,
  countedFileSql,
  inAudioCountedFileSetSql,
  inAudioCountedFileSql,
  inCountedFileSql,
  notHiddenFileSql,
  uncountedAudioFilesCteSql,
} from "./counted-files"
import { PLAN_UNIT_FILE_PREDICATE } from "./plan-units"
import { AUDIO_CUES_ROLE, TIMELINE_CONTENT_ROLE } from "../../src/lib/parsers/types"

describe("counted files", () => {
  it("hides exactly the editor's hidden timeline roles", () => {
    expect([...HIDDEN_FILE_ROLES]).toEqual([AUDIO_CUES_ROLE, TIMELINE_CONTENT_ROLE])
  })

  it("is the plan board's rule, unchanged", () => {
    expect(PLAN_UNIT_FILE_PREDICATE).toBe(countedFileSql("f"))
    expect(PLAN_UNIT_FILE_PREDICATE).toBe(
      "f.deleted_at IS NULL AND COALESCE(f.role, '') NOT IN ('audio-cues', 'timeline-content')",
    )
  })

  it("applies to the alias it is given", () => {
    expect(notHiddenFileSql("af")).toBe("COALESCE(af.role, '') NOT IN ('audio-cues', 'timeline-content')")
    expect(countedFileSql("x")).toContain("x.deleted_at IS NULL")
    expect(inCountedFileSql("c")).toContain("uncounted_file.id = c.file_id")
  })

  it("keeps the cue sheet for recordings, and only drops deleted files and caption-track content", () => {
    const sql = inAudioCountedFileSql("a")
    expect(sql).toContain("uncounted_audio_file.id = a.file_id")
    expect(sql).toContain("uncounted_audio_file.deleted_at IS NOT NULL")
    expect(sql).toContain("COALESCE(uncounted_audio_file.role, '') = 'timeline-content'")
    expect(sql).not.toContain("audio-cues")
  })

  // The org dashboard's audio rollup filters every take on the page, so it
  // takes the SET form (a per-take probe is what took it past the 15s abort).
  it("has a set form for recordings that keeps the cue sheet too", () => {
    const cte = uncountedAudioFilesCteSql("SELECT project_id FROM policy")
    expect(cte).toMatch(/^uncounted_audio_files AS MATERIALIZED \(/)
    expect(cte).toContain("uaf.project_id IN (SELECT project_id FROM policy)")
    expect(cte).toContain("COALESCE(uaf.role, '') = 'timeline-content'")
    expect(cte).not.toContain("audio-cues")
    const filter = inAudioCountedFileSetSql("a")
    expect(filter).toContain("FROM uncounted_audio_files uncounted_audio")
    expect(filter).toContain("uncounted_audio.file_id = a.file_id")
    expect(filter).not.toContain("FROM files")
  })
})
