// AQU-1566: the shared counting rule must name exactly the roles the editor
// hides, and the plan board must keep counting with it. Either drifting would
// put a file in one total and not another on the same screen.
import { describe, expect, it } from "vitest"
import { HIDDEN_FILE_ROLES, countedFileSql, inAudioCountedFileSql, inCountedFileSql, notHiddenFileSql } from "./counted-files"
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
})
