// AQU-2510: the recorder's Generate speaks in a voice you can choose, and the
// panel says which one it would use before you spend the credits.

import { describe, it, expect, beforeEach } from "vitest"
import {
  NO_RECORDER_VOICE_PICKS,
  recorderVoiceChoice,
  recorderVoiceOverride,
  recorderVoicePicks,
  rememberRecorderVoicePicks,
  resetRecorderVoicePicksForTests,
  withRecorderVoicePick,
} from "./recorder-voice"
import { characterCastKey, NO_CAST_VOICE } from "./voices"
import type { CellData } from "@/hooks/useCells"
import type { ProjectTtsSettings, Voice } from "@/lib/parsers/types"

const voice = (id: string, name: string): Voice => ({ id, name, color: "#000" }) as Voice

const NARRATOR = voice("v-narrator", "Narrator")
const CHIP = voice("v-chip", "Chip Ingram")
const CLONE = voice("v-clone", "Test Arabic Chip")

const settings = (over: Partial<ProjectTtsSettings> = {}): ProjectTtsSettings =>
  ({ voices: [NARRATOR, CHIP, CLONE], defaultVoiceId: NARRATOR.id, ...over }) as ProjectTtsSettings

const cell = (over: Partial<CellData> = {}): CellData =>
  ({ id: "c1", fileId: "f1", original: "hello", translated: "bonjour", ...over }) as unknown as CellData

describe("recorderVoiceChoice", () => {
  it("falls back to the project default when nothing casts the line", () => {
    const choice = recorderVoiceChoice({ settings: settings(), subject: cell() })
    expect(choice).toEqual({ voice: NARRATOR, source: "default" })
  })

  it("defaults to the line's own cast voice", () => {
    const choice = recorderVoiceChoice({
      settings: settings({ castAssignments: { c1: CHIP.id } }),
      subject: cell(),
    })
    expect(choice).toEqual({ voice: CHIP, source: "cast" })
  })

  it("defaults to the line's CHARACTER cast voice (AQU-2125)", () => {
    const choice = recorderVoiceChoice({
      settings: settings({ castAssignments: { [characterCastKey("JESUS")]: CHIP.id } }),
      subject: cell({ metadata: { cast_name: "JESUS" } }),
    })
    expect(choice).toEqual({ voice: CHIP, source: "cast" })
  })

  it("honours the line's own pinned voice when the cast says nothing", () => {
    const choice = recorderVoiceChoice({ settings: settings(), subject: cell(), cellVoiceId: CLONE.id })
    expect(choice).toEqual({ voice: CLONE, source: "cast" })
  })

  // THE WHOLE POINT OF THE TICKET: the cloned voice the user prepared.
  it("a pick on this line beats its cast voice", () => {
    const choice = recorderVoiceChoice({
      settings: settings({ castAssignments: { c1: CHIP.id } }),
      subject: cell(),
      picks: { byCell: { c1: CLONE.id } },
    })
    expect(choice).toEqual({ voice: CLONE, source: "pick" })
  })

  it("carries the last pick onto a line nobody cast, so repeat generation does not re-ask", () => {
    const choice = recorderVoiceChoice({
      settings: settings(),
      subject: cell({ id: "c2" }),
      picks: { carried: CLONE.id, byCell: { c1: CLONE.id } },
    })
    expect(choice).toEqual({ voice: CLONE, source: "carried" })
  })

  // Parity with the editor's character-tag path: a deliberately cast line is
  // not re-voiced by a pick made on some other line.
  it("a carried pick does NOT override another line's cast voice", () => {
    const choice = recorderVoiceChoice({
      settings: settings({ castAssignments: { c2: CHIP.id } }),
      subject: cell({ id: "c2" }),
      picks: { carried: CLONE.id, byCell: { c1: CLONE.id } },
    })
    expect(choice).toEqual({ voice: CHIP, source: "cast" })
  })

  it("a cast entry of NO_CAST_VOICE stops the lookup there (AQU-2038)", () => {
    const choice = recorderVoiceChoice({
      settings: settings({ castAssignments: { c1: NO_CAST_VOICE, [characterCastKey("JESUS")]: CHIP.id } }),
      subject: cell({ metadata: { cast_name: "JESUS" } }),
    })
    expect(choice).toEqual({ voice: NARRATOR, source: "default" })
  })

  // AQU-1941: the phantom-voice prune can remove a voice between the pick and
  // the press. A pick naming a voice that is gone must not resolve to the
  // default WEARING the "pick" label — the panel would claim a choice the user
  // can no longer see in the list.
  it("ignores a pick naming a voice the project no longer has", () => {
    const choice = recorderVoiceChoice({
      settings: settings(),
      subject: cell(),
      picks: { carried: "v-deleted", byCell: { c1: "v-deleted" } },
    })
    expect(choice).toEqual({ voice: NARRATOR, source: "default" })
  })

  it("resolves a cue through the linked subtitle's assignment (a cue has none)", () => {
    const choice = recorderVoiceChoice({
      settings: settings({ castAssignments: { "sub-9": CHIP.id } }),
      subject: "sub-9",
    })
    expect(choice).toEqual({ voice: CHIP, source: "cast" })
  })

  it("falls back to the first voice in the library with no default pinned", () => {
    const choice = recorderVoiceChoice({ settings: settings({ defaultVoiceId: undefined }), subject: cell() })
    expect(choice).toEqual({ voice: NARRATOR, source: "default" })
  })

  it("resolves the built-in narrator on a project with no voices at all", () => {
    const choice = recorderVoiceChoice({ settings: undefined, subject: cell() })
    expect(choice.source).toBe("default")
    expect(choice.voice.name).toBe("Narrator")
  })
})

describe("recorderVoiceOverride", () => {
  // The containment rule: a session that never opens the picker generates
  // through exactly the code it always did.
  it("overrides for a pick and a carried pick only", () => {
    expect(recorderVoiceOverride({ voice: CLONE, source: "pick" })).toBe(CLONE.id)
    expect(recorderVoiceOverride({ voice: CLONE, source: "carried" })).toBe(CLONE.id)
    expect(recorderVoiceOverride({ voice: CHIP, source: "cast" })).toBeUndefined()
    expect(recorderVoiceOverride({ voice: NARRATOR, source: "default" })).toBeUndefined()
    expect(recorderVoiceOverride(null)).toBeUndefined()
  })
})

describe("withRecorderVoicePick", () => {
  it("files the pick under the line and carries it, without mutating the input", () => {
    const next = withRecorderVoicePick(NO_RECORDER_VOICE_PICKS, cell(), CLONE.id)
    expect(next).toEqual({ carried: CLONE.id, byCell: { c1: CLONE.id } })
    expect(NO_RECORDER_VOICE_PICKS.byCell).toEqual({})
    const after = withRecorderVoicePick(next, cell({ id: "c2" }), CHIP.id)
    expect(after).toEqual({ carried: CHIP.id, byCell: { c1: CLONE.id, c2: CHIP.id } })
  })
})

describe("the session memory", () => {
  beforeEach(() => {
    resetRecorderVoicePicksForTests()
  })

  it("remembers a project's picks across a close and reopen, and keeps projects apart", () => {
    expect(recorderVoicePicks("p1")).toEqual(NO_RECORDER_VOICE_PICKS)
    rememberRecorderVoicePicks("p1", withRecorderVoicePick(NO_RECORDER_VOICE_PICKS, cell(), CLONE.id))
    expect(recorderVoicePicks("p1").carried).toBe(CLONE.id)
    expect(recorderVoicePicks("p2")).toEqual(NO_RECORDER_VOICE_PICKS)
  })
})
